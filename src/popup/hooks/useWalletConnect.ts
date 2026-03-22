/**
 * useWalletConnect — WalletConnect v2 pairing + signing hook.
 *
 * Designed for popup/React context only (not background service worker).
 * The WC client holds a WebSocket to the relay; this is fine in the popup
 * window which stays alive while the user interacts.
 *
 * Supported wallets:
 *   Algorand — Pera Wallet, Defly, Lute (algorand chain)
 *   Voi      — Lute (voi chain)
 *
 * Flow:
 *   1. startPairing(chain) → creates WC session proposal → returns URI + QR data URL
 *   2. User scans QR with their wallet app
 *   3. Mobile wallet approves → session state updates with WCSession
 *   4. Caller stores session via WC_ADD_ACCOUNT background message
 *
 * Signing (for Send modal):
 *   signTransaction(sessionTopic, chain, txn, signerAddress) → signed bytes
 */

import { useState, useCallback, useRef } from "react";
import SignClient from "@walletconnect/sign-client";
import QRCode from "qrcode";
import {
  WC_PROJECT_ID,
  WC_RELAY_URL,
  WC_APP_URL,
  WC_CHAIN_ID,
  WC_METHOD_SIGN_TXN,
} from "@shared/constants";
import { appendDebugLog, sanitizeTopic } from "@shared/debug-log";
import { extractWCSignedTxn } from "@shared/utils/crypto";
import type { ChainId } from "@shared/types/chain";
import algosdk from "algosdk";

export interface WCSession {
  topic: string;
  peerName: string;
  peerIcon?: string;
  addresses: string[];
  /** Actual chain the wallet approved the session for, derived from session namespaces */
  chain: ChainId;
}

export interface UseWalletConnectReturn {
  qrDataUrl: string | null;
  wcUri: string | null;
  connecting: boolean;
  session: WCSession | null;
  error: string | null;
  startPairing: (chain: ChainId) => Promise<void>;
  signTransaction: (
    sessionTopic: string,
    chain: ChainId,
    txn: algosdk.Transaction,
    signerAddress: string
  ) => Promise<Uint8Array>;
  signGroup: (
    sessionTopic: string,
    chain: ChainId,
    txns: algosdk.Transaction[],
    signerAddress: string
  ) => Promise<Uint8Array[]>;
  /**
   * Sign a transaction group where only a subset of transactions need the
   * user's signature (e.g. a Haystack swap group containing logic-sig txns).
   * Transactions NOT in indexesToSign are sent with signers:[] (wallet skips them).
   * Returns a parallel array: Uint8Array for signed slots, null for unsigned slots.
   */
  signGroupIndexed: (
    sessionTopic: string,
    chain: ChainId,
    txns: algosdk.Transaction[],
    indexesToSign: number[],
    signerAddress: string
  ) => Promise<(Uint8Array | null)[]>;
  reset: () => void;
}

/**
 * Reverse map: WC chain reference → ChainId.
 * Built from WC_CHAIN_ID at module load so it stays in sync automatically.
 * e.g. "wGHE2Pwdvd7S12BL5FaOP20EGYesN73k" → "algorand"
 *      "r20fSQI8gWe_kFZziNonSPCXLwcQmH_n"  → "voi"
 */
const WC_REF_TO_CHAIN: Record<string, ChainId> = Object.fromEntries(
  Object.entries(WC_CHAIN_ID).map(([chainId, wcChain]) => [
    wcChain.split(":")[1], // reference part after "algorand:"
    chainId as ChainId,
  ])
);

export function useWalletConnect(): UseWalletConnectReturn {
  const clientRef = useRef<InstanceType<typeof SignClient> | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [wcUri, setWcUri] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [session, setSession] = useState<WCSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const getClient = useCallback(async () => {
    if (clientRef.current) {
      console.log("[WC] Reusing existing SignClient");
      return clientRef.current;
    }
    if (!WC_PROJECT_ID) {
      throw new Error(
        "WalletConnect Project ID is not configured.\n" +
        "Add VITE_WC_PROJECT_ID=<your-id> to .env\n" +
        "Get a free ID at https://cloud.walletconnect.com"
      );
    }


    // The WC relay WebSocket can hang silently in extension contexts (Chrome
    // drops the connection without firing onerror). Race against a timeout so
    // the user gets a meaningful error instead of an infinite spinner.
    const RELAY_TIMEOUT_MS = 15_000;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(
          `Could not reach the WalletConnect relay after ${RELAY_TIMEOUT_MS / 1000}s.\n\n` +
          `• Make sure relay.walletconnect.com is not blocked by a firewall or VPN.\n` +
          `• Check chrome://extensions → Errors for permission issues.\n` +
          `• Project ID: ${WC_PROJECT_ID.slice(0, 8)}…`
        ));
      }, RELAY_TIMEOUT_MS);
    });

    try {
      const client = await Promise.race([
        SignClient.init({
          projectId: WC_PROJECT_ID,
          relayUrl: WC_RELAY_URL,
          metadata: {
            name: "AlgoVoi",
            description: "Web3 wallet for Algorand + Voi with x402 payments",
            // Must be an https:// URL — mobile wallets validate and may reject
            // chrome-extension:// URLs, causing silent failures.
            url: WC_APP_URL,
            // Empty icons: chrome-extension:// icon URLs are not fetchable from
            // a mobile device and can cause wallet apps to fail the connection.
            icons: [],
          },
        }),
        timeoutPromise,
      ]);

      clientRef.current = client;

      // Brief settle: the relay WebSocket is open after init() but the internal
      // transport may not have finished flushing its handshake frames. Calling
      // connect() immediately can hit a window where subscribe() gets queued
      // but never ACK'd, causing the 15 s connect timeout. 500 ms is enough
      // for the relay to finish the opening handshake on slow connections.
      await new Promise<void>((r) => setTimeout(r, 500));

      return client;
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
    }
  }, []);

  const startPairing = useCallback(async (chain: ChainId) => {
    setError(null);
    setSession(null);
    setQrDataUrl(null);
    setWcUri(null);
    setConnecting(true);

    // Force a fresh SignClient for every new pairing attempt.  Reusing an old
    // client risks stale pairing-topic subscriptions that prevent session_settle
    // delivery.  We destroy the old client here so getClient() creates a new one.
    if (clientRef.current) {
      try { await (clientRef.current as any).core?.relayer?.transportClose?.(); } catch {}
      clientRef.current = null;
    }

    // Clear PAIRING-specific localStorage entries so the new client starts with
    // clean relay subscriptions.  We deliberately keep wc@2:client:session and
    // wc@2:core:keychain so that existing WC accounts can still sign transactions.
    try {
      const pairingKeys = [
        "wc@2:core:pairing",              // stale active/pending pairings
        "wc@2:client:proposal",           // stale unresolved proposals
        "wc@2:core:relayer:subscriptions",// stale topic subscriptions (root cause fix)
      ];
      pairingKeys.forEach(k => localStorage.removeItem(k));
    } catch (e) {
      console.warn("[WC] Could not clear stale pairing data:", e);
    }

    // Resolve CAIP-2 chain id; fall back to Algorand mainnet for unknown chains
    const wcChain = WC_CHAIN_ID[chain] ?? WC_CHAIN_ID["algorand"];

    try {
      const proposal = {
        // AVM wallets (Pera, Defly, Lute) require requiredNamespaces to parse
        // the session proposal correctly. The WC SDK warns this is deprecated
        // but it is still the correct wire format for Algorand wallets (2026).
        requiredNamespaces: {
          algorand: {
            methods: [WC_METHOD_SIGN_TXN],
            chains: [wcChain],
            events: [],
          },
        },
      };

      // Race client.connect() against a hard timeout, with one automatic retry.
      // connect() internally calls relayer.subscribe() — a JSON-RPC round-trip
      // with no built-in timeout in the WC SDK. The relay can ACK SignClient.init()
      // then stall on subscribe (brief relay hiccup, extension WebSocket quirk).
      // One silent retry self-heals transient failures without user intervention.
      const CONNECT_TIMEOUT_MS = 15_000;
      const MAX_CONNECT_ATTEMPTS = 2;

      let client = await getClient();
      let connectResult: Awaited<ReturnType<typeof client.connect>> | null = null;

      for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
        if (attempt > 1) {
          // Destroy the stale client and start fresh for the retry.
          appendDebugLog("wc:connect_retry", { attempt });
          try { await (clientRef.current as any)?.core?.relayer?.transportClose?.(); } catch {}
          clientRef.current = null;
          try {
            ["wc@2:core:pairing", "wc@2:client:proposal", "wc@2:core:relayer:subscriptions"]
              .forEach(k => localStorage.removeItem(k));
          } catch {}
          client = await getClient();
        }

        let connectTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;
        try {
          const result = await Promise.race([
            client.connect(proposal),
            new Promise<never>((_, reject) => {
              connectTimeoutHandle = setTimeout(() => {
                timedOut = true;
                reject(new Error("connect_timeout"));
              }, CONNECT_TIMEOUT_MS);
            }),
          ]);
          if (connectTimeoutHandle !== null) clearTimeout(connectTimeoutHandle);
          connectResult = result;
          break; // success — exit retry loop
        } catch (e) {
          if (connectTimeoutHandle !== null) clearTimeout(connectTimeoutHandle);
          if (!timedOut || attempt === MAX_CONNECT_ATTEMPTS) {
            throw new Error(
              "Timed out generating a WalletConnect pairing URI (15s).\n\n" +
              "• Check your internet connection.\n" +
              "• Tap \"Try again\" to reconnect."
            );
          }
          // First attempt timed out — loop continues with a fresh client
        }
      }

      const { uri, approval } = connectResult!;

      // A missing URI means the SDK could not create a fresh pairing.
      // Surfacing it as an explicit error prevents the code from falling
      // into approval() and waiting 5 minutes for a scan that can never
      // happen (the second indefinite-spinner path).
      if (!uri) {
        throw new Error(
          "WalletConnect did not return a pairing URI.\n\n" +
          "Tap \"Try again\" to generate a fresh QR code."
        );
      }

      setWcUri(uri);
      appendDebugLog("wc:qr_generate_start", { uriLen: uri.length });
      // Render QR code as a data URL (white background, black dots).
      // Race against a 5 s timeout: QRCode.toDataURL() calls Canvas APIs
      // internally; in some extension contexts the canvas can stall silently,
      // leaving qrDataUrl null and the step stuck on "waiting" forever.
      let qrTimeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const dataUrl = await Promise.race([
        QRCode.toDataURL(uri, {
          width: 260,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" },
          errorCorrectionLevel: "M",
        }),
        new Promise<never>((_, reject) => {
          qrTimeoutHandle = setTimeout(
            () => reject(new Error(
              "QR code generation timed out (5s).\n\n" +
              "Tap \"Try again\" to reconnect."
            )),
            5_000
          );
        }),
      ]);
      if (qrTimeoutHandle !== null) clearTimeout(qrTimeoutHandle);
      appendDebugLog("wc:qr_generate_done", { ok: !!dataUrl, len: dataUrl?.length ?? 0 });
      // A falsy dataUrl would leave qrDataUrl null and the step stuck on
      // "waiting" — surface it as an explicit error instead.
      if (!dataUrl) {
        throw new Error(
          "Failed to render WalletConnect QR code.\n\n" +
          "Tap \"Try again\" to reconnect."
        );
      }
      setQrDataUrl(dataUrl);

      // ── Wait for wallet approval ─────────────────────────────────────────────
      //
      // Three concurrent races:
      //   1. approvalPromise     — SDK event-driven path (normal)
      //   2. sessionFromPoll     — fallback poller: catches sessions that land in
      //                           the SDK store even if the approval event was
      //                           swallowed or fired before the listener was ready
      //   3. approvalTimeout     — 5-minute hard limit
      //
      // Why the poller? Some WC SDK versions process wc_sessionSettle and write
      // the session to client.session but silently drop the internal event,
      // leaving approvalPromise pending forever. The poller detects this case.
      //
      // Why store approval() in a variable? Calling approval() twice registers
      // duplicate event listeners inside the SDK. We call it once here and reuse
      // the same promise in both the race and the ACK grace wait below.

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const approvalPromise: Promise<any> = approval();
      appendDebugLog("wc:approval_promise_created", { uriPresent: !!uri });

      const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      const approvalTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(
          "Session proposal expired (5 min timeout).\n\n" +
          "Tap \"Try again\" to generate a fresh QR code."
        )), APPROVAL_TIMEOUT_MS)
      );

      // Snapshot session count before waiting so we only react to NEW sessions
      const sessionCountBefore = client.session.getAll().length;
      let pollHandle: ReturnType<typeof setInterval> | null = null;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessionFromPoll = new Promise<any>((resolve) => {
        pollHandle = setInterval(() => {
          const sessions = client.session.getAll();
          if (sessions.length > sessionCountBefore) {
            const s = sessions[sessions.length - 1];
            resolve(s);
          }
        }, 500);
      });

      // Track which path wins for debug logging
      let approvalWon = false;
      const trackedApproval = approvalPromise.then((v: any) => { approvalWon = true; return v; });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const approved: any = await Promise.race([
        trackedApproval,
        sessionFromPoll,
        approvalTimeoutPromise,
      ]);

      // Clean up the poller
      if (pollHandle !== null) clearInterval(pollHandle);
      appendDebugLog("wc:race_winner", {
        winner: approvalWon ? "approval" : "poller",
        topic: sanitizeTopic(approved?.topic),
      });

      // ACK grace wait: if the poller fired first, approvalPromise may not have
      // finished sending the wc_sessionSettle ACK on the pairing topic yet.
      // Pera/Defly spin until they receive that ACK. Wait up to 2 s for
      // approvalPromise to complete so the SDK flushes the ACK over the relay
      // WebSocket before the confirm UI is shown (and before window.close()
      // can destroy the WebSocket). No-op when approvalPromise already resolved.
      let graceCompleted = false;
      await Promise.race([
        approvalPromise.catch(() => {}).then(() => { graceCompleted = true; }),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
      appendDebugLog("wc:grace_wait_done", { graceCompleted });

      // Ping the wallet on the new session topic.  The SDK's internal sendResult()
      // (which sends the wc_sessionSettle ACK on the PAIRING topic) can fail if the
      // relay WebSocket is in a half-closed state after delivering the settle message.
      // A session ping on the SESSION topic uses the fresh session connection and
      // gives the wallet app a second signal that the session is live, stopping its
      // "waiting for dApp" spinner even if the pairing-topic ACK was dropped.
      try {
        await client.ping({ topic: approved.topic });
        appendDebugLog("wc:ping_ok", { topic: sanitizeTopic(approved?.topic) });
      } catch {
        // Non-fatal: session may still be usable even if ping times out.
        appendDebugLog("wc:ping_failed", { topic: sanitizeTopic(approved?.topic) });
      }

      // Relay ACK delivery delay: the wc_sessionSettle ACK travels on the PAIRING
      // topic (not the session topic). The ping above confirms the session is alive
      // but does NOT guarantee the pairing-topic ACK has reached the wallet.
      // Waiting here gives the relay additional time to deliver the ACK so Pera/Defly
      // can clear their "waiting for dApp" spinner before the confirm UI appears.
      await new Promise<void>((r) => setTimeout(r, 1500));
      appendDebugLog("wc:relay_ack_delay_done");

      // peer metadata is nested differently depending on which path resolved
      const peerMeta = approved.peer?.metadata ?? approved.peer ?? {};

      // Extract addresses from the approved namespace.
      // CAIP-10 format: "algorand:CHAIN_REF:ADDRESS"
      const nsAccounts = approved.namespaces?.algorand?.accounts ?? [];
      const addresses = nsAccounts
        .map((a: string) => a.split(":").pop()!)
        .filter(Boolean);

      // Derive the actual approved chain from the first CAIP-10 account.
      // The chain reference in "algorand:CHAIN_REF:ADDRESS" is the authoritative
      // source — the wallet decided which chain to approve, not our UI prop.
      const firstAccount: string = nsAccounts[0] ?? "";
      const chainRef = firstAccount.split(":")[1] ?? "";
      const approvedChain: ChainId = WC_REF_TO_CHAIN[chainRef] ?? chain;

      setSession({
        topic: approved.topic,
        peerName: peerMeta.name ?? "Mobile Wallet",
        peerIcon: peerMeta.icons?.[0],
        addresses,
        chain: approvedChain,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[WC] startPairing error:", msg, err);
      appendDebugLog("wc:error", { msg: msg.slice(0, 120) });
      setError(msg);
    } finally {
      setConnecting(false);
    }
  }, [getClient]);

  /**
   * Sign an algosdk Transaction using the connected wallet via WalletConnect.
   * The `chain` parameter ensures the request is sent to the correct CAIP-2 chain.
   * Returns the signed bytes.
   */
  const signTransaction = useCallback(
    async (
      sessionTopic: string,
      chain: ChainId,
      txn: algosdk.Transaction,
      signerAddress: string
    ): Promise<Uint8Array> => {
      const client = await getClient();

      if (!client.session.get(sessionTopic)) {
        throw new Error(
          "WalletConnect session expired — remove and reconnect your wallet via the + Connect button."
        );
      }

      const wcChain = WC_CHAIN_ID[chain] ?? WC_CHAIN_ID["algorand"];

      // Encode unsigned transaction as base64 msgpack
      const txnBytes = txn.toByte();
      const txnB64 = btoa(String.fromCharCode(...txnBytes));

      // ARC-0025 / Pera/Defly format: array of txn groups.
      // Use `unknown` — Defly may return [[string]] (nested) instead of [string] (flat).
      const result = await Promise.race([
        client.request<unknown>({
          topic: sessionTopic,
          chainId: wcChain,
          request: {
            method: WC_METHOD_SIGN_TXN,
            params: [[{ txn: txnB64, signers: [signerAddress] }]],
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(
              "Wallet did not respond in 60s — open your wallet app and try again. " +
              "If this keeps happening, remove and reconnect the account."
            )),
            60_000
          )
        ),
      ]);

      // extractWCSignedTxn flattens [[str]] → [str] and decodes URL-safe base64.
      return extractWCSignedTxn(result);
    },
    [getClient]
  );

  const signGroup = useCallback(
    async (
      sessionTopic: string,
      chain: ChainId,
      txns: algosdk.Transaction[],
      signerAddress: string
    ): Promise<Uint8Array[]> => {
      const client  = await getClient();

      if (!client.session.get(sessionTopic)) {
        throw new Error(
          "WalletConnect session expired — remove and reconnect your wallet via the + Connect button."
        );
      }

      const wcChain = WC_CHAIN_ID[chain] ?? WC_CHAIN_ID["algorand"];

      const txnParams = txns.map((txn) => {
        const bytes = txn.toByte();
        return { txn: btoa(String.fromCharCode(...bytes)), signers: [signerAddress] };
      });

      const result = await Promise.race([
        client.request<unknown>({
          topic: sessionTopic,
          chainId: wcChain,
          request: { method: WC_METHOD_SIGN_TXN, params: [txnParams] },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(
              "Wallet did not respond in 60s — open your wallet app and try again. " +
              "If this keeps happening, remove and reconnect the account."
            )),
            60_000
          )
        ),
      ]);

      // WC group response: [signedB64_0, signedB64_1, ...] — one element per txn.
      const raw = Array.isArray(result) ? result : [result];
      return raw.map((r): Uint8Array => {
        if (r instanceof Uint8Array) return r;
        if (r === null || r === undefined) throw new Error("Wallet did not sign all transactions");
        if (typeof r === "string") {
          if (!r) throw new Error("Wallet rejected a transaction in the group");
          // decode URL-safe or standard base64
          return Uint8Array.from(atob(r.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
        }
        if (Array.isArray(r)) return extractWCSignedTxn(r);
        throw new Error("Wallet rejected the transaction");
      });
    },
    [getClient]
  );

  const signGroupIndexed = useCallback(
    async (
      sessionTopic: string,
      chain: ChainId,
      txns: algosdk.Transaction[],
      indexesToSign: number[],
      signerAddress: string
    ): Promise<(Uint8Array | null)[]> => {
      const client  = await getClient();
      const wcChain = WC_CHAIN_ID[chain] ?? WC_CHAIN_ID["algorand"];

      // Guard: check the session is still live in the local WC store before
      // sending a request that will hang indefinitely on a dead topic.
      if (!client.session.get(sessionTopic)) {
        throw new Error(
          "WalletConnect session expired — remove and reconnect your wallet via the + Connect button."
        );
      }

      // Send every txn for context; signers:[] tells the wallet to skip unsigned ones.
      const txnParams = txns.map((txn, i) => ({
        txn: btoa(String.fromCharCode(...txn.toByte())),
        signers: indexesToSign.includes(i) ? [signerAddress] : [],
      }));

      // 60-second timeout — if the relay delivers but the phone never responds,
      // surface a reconnect hint rather than hanging for minutes.
      const SIGN_TIMEOUT_MS = 60_000;
      const result = await Promise.race([
        client.request<unknown>({
          topic:   sessionTopic,
          chainId: wcChain,
          request: { method: WC_METHOD_SIGN_TXN, params: [txnParams] },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(
              "Wallet did not respond in 60s — open your wallet app and try again. " +
              "If this keeps happening, remove and reconnect the account."
            )),
            SIGN_TIMEOUT_MS
          )
        ),
      ]);

      // WC returns one element per txn; unsigned slots come back as null/"".
      const raw = Array.isArray(result) ? result : [result];
      return txns.map((_, i) => {
        if (!indexesToSign.includes(i)) return null;
        const r = raw[i];
        if (!r) return null;
        if (r instanceof Uint8Array) return r;
        if (typeof r === "string" && r) {
          return Uint8Array.from(
            atob(r.replace(/-/g, "+").replace(/_/g, "/")),
            (c) => c.charCodeAt(0)
          );
        }
        if (Array.isArray(r)) return extractWCSignedTxn(r);
        return null;
      });
    },
    [getClient]
  );

  const reset = useCallback(() => {
    setQrDataUrl(null);
    setWcUri(null);
    setConnecting(false);
    setSession(null);
    setError(null);
  }, []);

  return { qrDataUrl, wcUri, connecting, session, error, startPairing, signTransaction, signGroup, signGroupIndexed, reset };
}
