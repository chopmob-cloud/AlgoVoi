/**
 * Central Chrome runtime message router.
 * All messages from content scripts, popup, and approval pages flow through here.
 */

import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import { getAccountState, getSuggestedParams, submitTransaction, waitForConfirmation, waitForIndexed } from "./chain-clients";
import { CHAINS, X402_VERSION } from "@shared/constants";
import {
  handleX402,
  buildAndSignPayment,
  buildPaymentTxnForWC,
  getPendingRequest,
  clearPendingRequest,
  resolveChain,
} from "./x402-handler";
import {
  handleMpp,
  buildAndSignMppPayment,
  buildMppPaymentTxnForWC,
  serializeMppCredential,
  getPendingMppRequest,
  clearPendingMppRequest,
  resolveMppChain,
} from "./mpp-handler";
import {
  handleAp2Payment,
  buildPaymentMandate,
  getPendingAp2Request,
  clearPendingAp2Request,
  getIntentMandates,
} from "./ap2-handler";
import { mcpResolveEnvoi } from "./mcp-client";
import {
  generatePairingUri,
  getActiveSessions,
  disconnectAgentSession,
  getPendingAgentSignRequest,
  approveAgentSignRequest,
  rejectAgentSignRequest,
} from "./web3wallet-handler";
import { WC_PROJECT_ID } from "@shared/constants";
import { base64ToBytes, randomId } from "@shared/utils/crypto";
import { formatAmount } from "@shared/utils/format";
import {
  getPendingApproval,
  requestApproval,
  resolveApproval,
  rejectApproval,
  countPendingByOrigin,
} from "./approval-handler";
import type { TxnSummary, PendingSignTxnsApproval, PendingSignBytesApproval } from "@shared/types/approval";
import type { X402PaymentPayload } from "@shared/types/x402";
import type { BgRequest } from "@shared/types/messages";
import type { ChainId } from "@shared/types/chain";

type SendResponse = (response: unknown) => void;

// ── Unlock rate-limiting ───────────────────────────────────────────────────────
// C2: Persisted in chrome.storage.session so brute-force counts survive SW suspension.
const MAX_UNLOCK_ATTEMPTS = 5;
const UNLOCK_LOCKOUT_MS   = 30_000; // 30 seconds
const RATE_LIMIT_SESSION_KEY = "algovou_unlock_rate";
interface RateEntry { count: number; resetAt: number }

async function checkUnlockRate(key: string): Promise<void> {
  const now = Date.now();
  const stored = await chrome.storage.session.get(RATE_LIMIT_SESSION_KEY);
  const rateMap = (stored[RATE_LIMIT_SESSION_KEY] as Record<string, RateEntry> | undefined) ?? {};
  const entry = rateMap[key];
  if (entry && now < entry.resetAt) {
    if (entry.count >= MAX_UNLOCK_ATTEMPTS) {
      const remaining = Math.ceil((entry.resetAt - now) / 1000);
      throw new Error(`Too many unlock attempts. Try again in ${remaining}s.`);
    }
    rateMap[key] = { count: entry.count + 1, resetAt: entry.resetAt };
  } else {
    rateMap[key] = { count: 1, resetAt: now + UNLOCK_LOCKOUT_MS };
  }
  await chrome.storage.session.set({ [RATE_LIMIT_SESSION_KEY]: rateMap });
}

async function clearUnlockRate(key: string): Promise<void> {
  const stored = await chrome.storage.session.get(RATE_LIMIT_SESSION_KEY);
  const rateMap = (stored[RATE_LIMIT_SESSION_KEY] as Record<string, RateEntry> | undefined) ?? {};
  delete rateMap[key];
  await chrome.storage.session.set({ [RATE_LIMIT_SESSION_KEY]: rateMap });
}

/** Parse decimal amount string → atomic BigInt without float rounding errors */
function parseDecimalToAtomic(amount: string, decimals: number): bigint {
  const clean = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error("Invalid amount");
  const [intStr, fracStr = ""] = clean.split(".");
  const fracPadded = fracStr.slice(0, decimals).padEnd(decimals, "0");
  const atomic = BigInt(intStr) * BigInt(10 ** decimals) + BigInt(fracPadded);
  // M1: Reject values that exceed the AVM uint64 maximum
  if (atomic > 18_446_744_073_709_551_615n) {
    throw new Error("Amount exceeds maximum representable value (uint64 overflow)");
  }
  return atomic;
}

export function registerMessageHandler(): void {
  chrome.runtime.onMessage.addListener(
    (
      message: BgRequest,
      sender: chrome.runtime.MessageSender,
      sendResponse: SendResponse
    ) => {
      // Always use tabId from Chrome's sender object — never trust message payload
      const tabId = sender.tab?.id ?? -1;
      handleMessage(message, tabId, sender, sendResponse);
      return true; // keep message channel open for async response
    }
  );
}

async function handleMessage(
  msg: BgRequest,
  tabId: number,
  sender: chrome.runtime.MessageSender,
  sendResponse: SendResponse
): Promise<void> {
  try {
    const result = await dispatch(msg, tabId, sender);
    sendResponse({ ok: true, data: result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    sendResponse({ ok: false, error });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dispatch(msg: BgRequest, tabId: number, sender: chrome.runtime.MessageSender): Promise<any> {
  switch (msg.type) {
    // ── Wallet lifecycle ──────────────────────────────────────────────────────
    case "WALLET_STATE": {
      const initialized = await walletStore.isInitialized();
      const lockState = initialized ? walletStore.getLockState() : "uninitialized";
      const meta = initialized ? await walletStore.getMeta() : null;
      return { lockState, meta };
    }

    case "WALLET_GET_META":
      return { meta: await walletStore.getMeta() };

    case "WALLET_INIT": {
      const { account } = await walletStore.initialize(msg.password, msg.mnemonic);
      return { success: true, account };
    }

    case "WALLET_UNLOCK": {
      // Rate-limit unlock attempts (keyed by sender origin or extension self)
      const unlockKey = sender.url ? new URL(sender.url).origin : "popup";
      await checkUnlockRate(unlockKey); // C2: now async (session storage)
      try {
        await walletStore.unlock(msg.password);
      } catch (err) {
        throw err; // rate counter already incremented; propagate to caller
      }
      await clearUnlockRate(unlockKey); // C2: now async; reset on success
      broadcastLockState();
      return { success: true };
    }

    case "WALLET_LOCK":
      walletStore.lock();
      broadcastLockState();
      return { success: true };

    case "WALLET_CREATE_ACCOUNT": {
      const account = await walletStore.createAccount(msg.name);
      return { account };
    }

    case "WALLET_IMPORT_ACCOUNT": {
      const account = await walletStore.importAccount(msg.name, msg.mnemonic);
      return { account };
    }

    case "WALLET_REMOVE_ACCOUNT":
      await walletStore.removeAccount(msg.id);
      return { success: true };

    case "WALLET_RENAME_ACCOUNT":
      await walletStore.renameAccount(msg.id, msg.name);
      return { success: true };

    case "WALLET_SET_ACTIVE_ACCOUNT":
      await walletStore.setActiveAccount(msg.id);
      return { success: true };

    case "WALLET_SET_CHAIN": {
      const switchChain = msg.chain as ChainId;
      // H1: Verify the node we're switching to actually serves the expected chain.
      // Prevents a compromised/misconfigured node URL from silently redirecting funds.
      try {
        const params = await getSuggestedParams(switchChain);
        const expectedHash = CHAINS[switchChain].genesisHash;
        // params.genesisHash is a Uint8Array — encode to base64 for comparison
        const genesisHashBytes = params.genesisHash ?? new Uint8Array(0);
        const actualHash = btoa(String.fromCharCode(...Array.from(genesisHashBytes)));
        if (actualHash !== expectedHash) {
          throw new Error(
            `Node genesis hash mismatch for ${switchChain}: ` +
            `expected ${expectedHash}, got ${actualHash}. ` +
            `The configured node URL may be incorrect.`
          );
        }
      } catch (err) {
        // Re-throw genesis mismatch; swallow unreachable-node errors to allow offline switch
        if (err instanceof Error && err.message.includes("genesis hash mismatch")) throw err;
        console.warn(`[AlgoVoi] Could not verify genesis hash for ${switchChain}:`, err);
      }
      await walletStore.setActiveChain(switchChain);
      broadcastChainChange(switchChain);
      return { success: true };
    }

    // ── Chain queries ─────────────────────────────────────────────────────────
    case "CHAIN_GET_ACCOUNT_STATE": {
      const state = await getAccountState(msg.address, msg.chain as ChainId);
      return { state };
    }

    // ── Native coin send ──────────────────────────────────────────────────────
    case "CHAIN_SEND_PAYMENT": {
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      // Validate destination address (throws if invalid)
      if (!algosdk.isValidAddress(msg.to)) throw new Error("Invalid destination address");
      const chain = msg.chain as ChainId;
      const meta = await walletStore.getMeta();
      const senderAddress = meta.accounts.find((a) => a.id === meta.activeAccountId)?.address;
      if (!senderAddress) throw new Error("No active account");
      const sk = await walletStore.getActiveSecretKey();
      const params = await getSuggestedParams(chain);
      const cfg = CHAINS[chain];
      // BigInt-safe decimal → atomic conversion (avoids float rounding errors)
      const amountAtomic = parseDecimalToAtomic(msg.amount, cfg.decimals);
      // Encode then byte-slice to the AVM 1000-byte note limit (safer than char-slice
      // which would overshoot for multi-byte characters).
      const note = msg.note
        ? new TextEncoder().encode(msg.note).slice(0, 1000)
        : undefined;
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: senderAddress,
        receiver: msg.to,
        amount: amountAtomic,
        note,
        suggestedParams: params,
      });
      const signedBytes = txn.signTxn(sk);
      const txId = await submitTransaction(chain, signedBytes);
      return { txId };
    }

    case "CHAIN_SEND_ASSET": {
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      if (!algosdk.isValidAddress(msg.to)) throw new Error("Invalid destination address");
      // M2: Bounds-check decimals — must be an integer in [0, 19].
      // Prevents parseDecimalToAtomic from receiving garbage that could cause
      // silent truncation, a 10**decimals explosion, or a uint64 overflow bypass.
      if (!Number.isInteger(msg.decimals) || msg.decimals < 0 || msg.decimals > 19) {
        throw new Error("Invalid decimals: must be an integer between 0 and 19");
      }
      const chain = msg.chain as ChainId;
      const meta = await walletStore.getMeta();
      const senderAddress = meta.accounts.find((a) => a.id === meta.activeAccountId)?.address;
      if (!senderAddress) throw new Error("No active account");
      const sk = await walletStore.getActiveSecretKey();
      const params = await getSuggestedParams(chain);
      // Use msg.decimals passed by the frontend (frontend has full AccountAsset metadata)
      const amountAtomic = parseDecimalToAtomic(msg.amount, msg.decimals);
      const note = msg.note
        ? new TextEncoder().encode(msg.note).slice(0, 1000)
        : undefined;
      const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: senderAddress,
        receiver: msg.to,
        assetIndex: msg.assetId,
        amount: amountAtomic,
        note,
        suggestedParams: params,
      });
      const signedBytes = txn.signTxn(sk);
      const txId = await submitTransaction(chain, signedBytes);
      return { txId };
    }

    // ── Submit pre-signed transaction (WalletConnect flow) ────────────────────
    case "CHAIN_SUBMIT_SIGNED": {
      // L5: Require wallet to be unlocked before submitting WC-signed transactions.
      // Closes the narrow window where a WC session could be used after auto-lock.
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      const chain = msg.chain as ChainId;
      const signedBytes = base64ToBytes(msg.signedTxn);
      const txId = await submitTransaction(chain, signedBytes);
      return { txId };
    }

    // ── WalletConnect account management ──────────────────────────────────────
    case "WC_ADD_ACCOUNT": {
      const account = await walletStore.addWCAccount(
        msg.name,
        msg.address,
        msg.sessionTopic,
        msg.peerName,
        msg.chain as ChainId | undefined
      );
      return { account };
    }

    // ── ARC-0027 dApp connector ───────────────────────────────────────────────
    case "ARC27_ENABLE": {
      // Use sender.url (Chrome-provided, unforgeable) — never trust msg.origin from content
      const senderOrigin = sender.url ? new URL(sender.url).origin : null;
      if (!senderOrigin) throw new Error("Cannot determine requesting site origin");
      const meta = await walletStore.getMeta();
      const address = meta.accounts.find((a) => a.id === meta.activeAccountId)?.address;
      if (!address) throw new Error("No active account");
      const addresses = msg.accounts ?? [address];

      // ── Validate requested accounts exist in this wallet ─────────────────────
      // MED-01: msg.accounts is dApp-controlled; reject unknown addresses before
      // they are registered, so connected-site state only holds real accounts.
      if (msg.accounts) {
        const knownAddresses = new Set(meta.accounts.map((a) => a.address));
        const unknown = msg.accounts.filter((addr) => !knownAddresses.has(addr));
        if (unknown.length > 0) {
          throw new Error(
            `Requested accounts not found in wallet: ${unknown.join(", ")}`
          );
        }
      }

      await walletStore.addConnectedSite(senderOrigin, addresses);
      return { accounts: addresses };
    }

    case "ARC27_SIGN_TXNS": {
      // ── Pre-conditions (fail fast before touching the approval queue) ────────
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();

      // Require an explicit enable() call before any signing request.
      // sender.url is Chrome-provided and unforgeable; msg.origin is ignored.
      const signOrigin = sender.url ? new URL(sender.url).origin : null;
      if (!signOrigin) throw new Error("Cannot determine requesting site origin");
      const signConnected = await walletStore.getConnectedAddresses(signOrigin);
      if (signConnected.length === 0) {
        throw new Error(
          `${signOrigin} is not connected. ` +
          `The site must call window.algorand.enable() before requesting signatures.`
        );
      }

      // ── Per-origin pending cap (mirrors x402-handler PENDING_CAP_PER_ORIGIN) ─
      // INFO-05: prevents a single dApp from flooding the approval queue.
      const SIGN_CAP_PER_ORIGIN = 5;
      if (countPendingByOrigin(signOrigin) >= SIGN_CAP_PER_ORIGIN) {
        throw new Error(
          "Too many pending signing requests from this site. " +
          "Please wait for existing requests to complete."
        );
      }

      const signMeta    = await walletStore.getMeta();
      const activeChain = signMeta.activeChain as ChainId;
      const chainCfg    = CHAINS[activeChain];

      // Pre-decode transactions to build display summaries AND run genesis checks
      // early, so the popup is never shown for a request that would fail to sign.
      const txnSummaries: TxnSummary[] = msg.txns.map((b64, i) => {
        const skipped = !!(msg.indexesToSign && !msg.indexesToSign.includes(i));
        if (skipped) return { type: "skip", sender: "", skipped: true };
        try {
          const txnBytes = base64ToBytes(b64);
          const txn = algosdk.decodeUnsignedTransaction(txnBytes);
          // C1 pre-check: reject wrong-chain transactions before opening popup
          const txnGenesisId = (txn as unknown as { genesisID?: string }).genesisID ?? "";
          if (txnGenesisId && txnGenesisId !== chainCfg.genesisId) {
            throw new Error(
              `Transaction ${i} genesisID "${txnGenesisId}" does not match ` +
              `active chain "${chainCfg.genesisId}". Switch chains before signing.`
            );
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = txn as unknown as Record<string, any>;
          const type: string   = t.type ?? "unknown";
          const sender: string = t.from?.toString?.() ?? t.sender?.toString?.() ?? "";
          const receiver: string | undefined = t.to?.toString?.() ?? t.receiver?.toString?.();
          let amount: string | undefined;
          if (typeof t.amount === "bigint" || typeof t.amount === "number") {
            try {
              amount = `${formatAmount(BigInt(t.amount), chainCfg.decimals)} ${chainCfg.ticker}`;
            } catch { amount = String(t.amount); }
          }
          const assetId: number | undefined = t.assetIndex || undefined;

          // ── Dangerous-field extraction ───────────────────────────────────────
          const rekeyTo: string | undefined =
            t.rekeyTo?.toString?.() || undefined;
          const closeRemainderTo: string | undefined =
            t.closeRemainderTo?.toString?.() || undefined;
          const assetCloseTo: string | undefined =
            t.assetCloseTo?.toString?.() || undefined;

          // Actual fee value — UI flags HIGH when > 10× minimum (10 000 µ)
          const feeMicroalgos: number | undefined =
            typeof t.fee === "bigint" ? Number(t.fee)
            : typeof t.fee === "number" ? t.fee
            : undefined;

          // Short validity window — flag when lastValid - firstValid < 10 rounds
          // (~40 s on Algorand). Indicates a time-pressure phishing attempt.
          const firstValid: number = typeof t.firstValid === "bigint" ? Number(t.firstValid)
            : typeof t.firstValid === "number" ? t.firstValid : 0;
          const lastValid: number  = typeof t.lastValid  === "bigint" ? Number(t.lastValid)
            : typeof t.lastValid  === "number" ? t.lastValid  : 0;
          const shortValidityWindow: true | undefined =
            firstValid > 0 && lastValid > 0 && (lastValid - firstValid) < 10
              ? true : undefined;

          // Decode note bytes — try UTF-8, fall back to hex preview
          let note: string | undefined;
          const noteBytes = t.note as Uint8Array | undefined;
          if (noteBytes && noteBytes.length > 0) {
            try {
              note = new TextDecoder("utf-8", { fatal: true })
                .decode(noteBytes.slice(0, 200));
              if (note.length > 120) note = note.slice(0, 120) + "…";
            } catch {
              note = Array.from(noteBytes.slice(0, 24))
                .map((b) => (b as number).toString(16).padStart(2, "0")).join(" ")
                + (noteBytes.length > 24 ? " …" : "");
            }
          }

          // Clawback — revocationTarget forces ASA transfer OUT of another account
          const clawbackFrom: string | undefined =
            t.revocationTarget?.toString?.() || t.assetRevocationTarget?.toString?.() || undefined;

          // Lease — non-zero Uint8Array means the field is set
          const leaseBytes = t.lease as Uint8Array | undefined;
          const hasLease: true | undefined =
            leaseBytes && leaseBytes.length > 0 && leaseBytes.some((b: number) => b !== 0)
              ? true : undefined;

          // Asset freeze fields (afrz transactions)
          const freezeTarget: string | undefined = type === "afrz"
            ? (t.freezeAccount?.toString?.() ?? t.freeze?.toString?.() ?? undefined)
            : undefined;
          // algosdk v3: assetFrozen field; fall back to frozen
          const freezeStateRaw = t.assetFrozen ?? t.frozen;
          const freezing: boolean | undefined = type === "afrz" && freezeStateRaw !== undefined
            ? Boolean(freezeStateRaw) : undefined;

          // Key registration — online (voteKey present) vs offline (no voteKey)
          const keyregOnline: boolean | undefined = type === "keyreg"
            ? !!(t.voteKey) : undefined;

          // appl onCompletion label
          const OC_NAMES: Record<number, string> = {
            0: "NoOp", 1: "OptIn", 2: "CloseOut",
            3: "ClearState", 4: "UpdateApp", 5: "DeleteApp",
          };
          // algosdk v3 uses onComplete (not onCompletion)
          const applType: string | undefined = type === "appl" && typeof t.onComplete === "number"
            ? (OC_NAMES[t.onComplete] ?? String(t.onComplete))
            : undefined;

          return {
            type, sender, receiver, amount, assetId,
            rekeyTo, closeRemainderTo, assetCloseTo,
            feeMicroalgos, note, applType, shortValidityWindow,
            clawbackFrom, hasLease, freezeTarget, freezing, keyregOnline,
          };
        } catch (err) {
          // Re-throw genesis mismatch errors; wrap decode errors as unknown
          if (err instanceof Error && err.message.includes("genesisID")) throw err;
          return { type: "unknown", sender: "", blind: true };
        }
      });

      // ── Queue approval — the message channel stays open until this resolves ──
      const signTxnsId = randomId();
      const signTxnsApproval: PendingSignTxnsApproval = {
        kind: "sign_txns",
        id: signTxnsId,
        origin: signOrigin,
        tabId,
        txns: msg.txns,
        indexesToSign: msg.indexesToSign,
        txnSummaries,
        timestamp: Date.now(),
      };
      // Throws if user rejects, TTL fires, or popup fails to open.
      await requestApproval(signTxnsApproval);

      // ── Post-approval: re-verify lock (user may have locked during popup) ────
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet locked during approval");
      walletStore.resetAutoLock();

      // ── Sign (re-runs genesis check as defence-in-depth) ────────────────────
      const freshMeta  = await walletStore.getMeta();
      const freshChain = freshMeta.activeChain as ChainId;
      const freshGenId = CHAINS[freshChain].genesisId;
      const sk = await walletStore.getActiveSecretKey();
      const stxns = msg.txns.map((b64, i) => {
        if (msg.indexesToSign && !msg.indexesToSign.includes(i)) return null;
        const txnBytes = base64ToBytes(b64);
        const txn = algosdk.decodeUnsignedTransaction(txnBytes);
        // C1: defence-in-depth genesis check post-approval
        const txnGenesisId = (txn as unknown as { genesisID?: string }).genesisID ?? "";
        if (txnGenesisId && txnGenesisId !== freshGenId) {
          throw new Error(
            `Transaction genesisID "${txnGenesisId}" does not match active chain ` +
            `"${freshGenId}". Switch to the correct chain before signing.`
          );
        }
        return btoa(String.fromCharCode(...txn.signTxn(sk)));
      });
      return { stxns };
    }

    case "ARC27_SIGN_BYTES": {
      // ── Pre-conditions ───────────────────────────────────────────────────────
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();

      const bytesOrigin = sender.url ? new URL(sender.url).origin : null;
      if (!bytesOrigin) throw new Error("Cannot determine requesting site origin");
      const bytesConnected = await walletStore.getConnectedAddresses(bytesOrigin);
      if (bytesConnected.length === 0) {
        throw new Error(
          `${bytesOrigin} is not connected. ` +
          `The site must call window.algorand.enable() before requesting signatures.`
        );
      }

      // ── Validate signer matches active account ────────────────────────────
      // ARC-0027: the wallet must sign with the requested signer. If the dApp
      // passes a signer the active account cannot satisfy, reject immediately
      // so the popup never shows a misleading "approving address X" prompt while
      // the actual key belongs to address Y.
      const signBytesMeta = await walletStore.getMeta();
      const activeForBytes = signBytesMeta.accounts.find(
        (a) => a.id === signBytesMeta.activeAccountId
      );
      if (!activeForBytes) throw new Error("No active account");
      if (msg.signer !== activeForBytes.address) {
        throw new Error(
          `Signer address does not match the active account. ` +
          `Requested: ${msg.signer}, Active: ${activeForBytes.address}`
        );
      }

      // ── Per-origin pending cap ────────────────────────────────────────────────
      // INFO-05: prevents a single dApp from flooding the approval queue.
      const SIGN_BYTES_CAP_PER_ORIGIN = 5;
      if (countPendingByOrigin(bytesOrigin) >= SIGN_BYTES_CAP_PER_ORIGIN) {
        throw new Error(
          "Too many pending signing requests from this site. " +
          "Please wait for existing requests to complete."
        );
      }

      // ── Queue approval ───────────────────────────────────────────────────────
      const signBytesId = randomId();
      const signBytesApproval: PendingSignBytesApproval = {
        kind: "sign_bytes",
        id: signBytesId,
        origin: bytesOrigin,
        tabId,
        data: msg.data,
        signer: msg.signer,
        timestamp: Date.now(),
      };
      await requestApproval(signBytesApproval);

      // ── Post-approval: re-verify lock ────────────────────────────────────────
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet locked during approval");
      walletStore.resetAutoLock();

      // ── Sign (MX prefix applied here — never before approval) ───────────────
      const sk = await walletStore.getActiveSecretKey();
      const dataBytes = base64ToBytes(msg.data);
      // Prefix with "MX" per ARC-1
      const prefixed = new Uint8Array([0x4d, 0x58, ...dataBytes]);
      const sig = algosdk.signBytes(prefixed, sk);
      return { sig: btoa(String.fromCharCode(...sig)) };
    }

    case "ARC27_DISCONNECT": {
      // H1: Use only the Chrome-provided sender.url — never trust msg.origin (dApp-controlled).
      // If sender.url is absent (non-content-script caller), return a no-op success rather
      // than allowing an unverifiable origin string to delete another site's connection record.
      if (!sender.url) return { success: true };
      const disconnectOrigin = new URL(sender.url).origin;
      await walletStore.removeConnectedSite(disconnectOrigin);
      return { success: true };
    }

    // ── x402 ─────────────────────────────────────────────────────────────────
    case "X402_PAYMENT_NEEDED": {
      const requestId = await handleX402({
        tabId: sender?.tab?.id ?? tabId,
        url: msg.url,
        method: msg.method,
        // The inpage script passes rawPaymentRequired (base64 PAYMENT-REQUIRED value)
        rawPaymentRequired: msg.paymentRequirements as unknown as string,
        // Pass the inpage-generated requestId for tab routing only.
        // x402-handler always generates its own internal ID as the map key.
        inpageRequestId: msg.requestId,
      });
      return { requestId };
    }

    case "X402_GET_PENDING": {
      const req = getPendingRequest(msg.requestId);
      return { request: req };
    }

    case "X402_APPROVE": {
      const req = getPendingRequest(msg.requestId);
      if (!req) throw new Error("Pending request not found");

      // ── Post-approval lock re-check ───────────────────────────────────────
      // Auto-lock may have fired between popup open and user clicking Approve
      // (up to APPROVAL_TTL_MS = 5 min). Fail-closed: reject rather than
      // attempt to sign with a missing or stale key.
      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet locked during approval");
      }
      walletStore.resetAutoLock();

      // Check if active account is WalletConnect — can't sign in background
      const approveMeta = await walletStore.getMeta();
      const activeAccount = approveMeta.accounts.find((a) => a.id === approveMeta.activeAccountId);

      if (activeAccount?.type === "walletconnect") {
        // Guard: WC sessions are chain-specific — reject before touching the WC SDK
        // if the payment's chain differs from the chain the session was approved for.
        const paymentChain = resolveChain(req.paymentRequirements.network);
        const accountChain = (activeAccount.wcChain ?? paymentChain ?? "algorand") as ChainId;
        // Only block when wcChain is explicitly recorded and mismatches the payment chain.
        // Accounts created before this field was added (wcChain undefined) skip the guard
        // and let the WC SDK validate the session namespaces directly.
        if (paymentChain && activeAccount.wcChain !== undefined && accountChain !== paymentChain) {
          throw new Error(
            `This payment requires ${CHAINS[paymentChain].name} but your wallet ` +
            `(${activeAccount.wcPeerName ?? "mobile wallet"}) was connected on ` +
            `${CHAINS[accountChain].name}.\n\n` +
            `To fix: remove this account (✕ next to the name), switch to the ` +
            `${CHAINS[paymentChain].name} chain, then use + Connect to re-pair your wallet.`
          );
        }
        // Build unsigned txn and return params to the approval popup.
        // The pending request is intentionally NOT cleared here —
        // it will be cleared by X402_WC_SIGNED once signing completes.
        const wcData = await buildPaymentTxnForWC(req);
        return { needsWcSign: true, ...wcData };
      }

      // Vault account — sign locally
      let paymentHeader: string, txId: string;
      ({ paymentHeader, txId } = await buildAndSignPayment(req));
      clearPendingRequest(msg.requestId);
      chrome.tabs.sendMessage(req.tabId, {
        type: "X402_RESULT",
        // Use inpageRequestId so the inpage _pendingX402 Map can resolve the
        // pending fetch. Falls back to req.id for requests predating this fix.
        requestId: req.inpageRequestId ?? req.id,
        approved: true,
        paymentHeader,
        txId,
      });
      return { paymentHeader, txId };
    }

    case "X402_WC_SIGNED": {
      const req = getPendingRequest(msg.requestId);
      if (!req) throw new Error("Pending request not found");

      const pr = req.paymentRequirements;
      const chain = resolveChain(pr.network);
      if (!chain) throw new Error(`Unsupported network: ${pr.network}`);

      const signedBytes = base64ToBytes(msg.signedTxnB64);

      // Submit and capture the on-chain txId for the proof payload.
      const txId = await submitTransaction(chain, signedBytes);

      // Wait for algod confirmation then poll indexer — eliminates tx_not_found.
      await waitForConfirmation(chain, txId, 8);
      await waitForIndexed(chain, txId);

      // Resolve the payer address from the active account.
      // Fail closed if the account cannot be identified — never send an empty proof.
      const wcMeta = await walletStore.getMeta();
      const payer = wcMeta.accounts.find((a) => a.id === wcMeta.activeAccountId)?.address;
      if (!payer) throw new Error("Cannot determine payer address for WC payment proof");

      // Re-encode as standard base64 in case Defly/Pera returned URL-safe base64
      const signedTxnStdB64 = btoa(String.fromCharCode(...signedBytes));
      const wcPayload: X402PaymentPayload = {
        x402Version: X402_VERSION,
        scheme: pr.scheme,
        network: pr.network,
        payload: {
          txId,
          payer,
          // Included during rollout for backward compat with pre-production servers.
          // Remove once all servers verify via txId only.
          transaction: signedTxnStdB64,
        },
      };
      const paymentHeader = btoa(JSON.stringify(wcPayload));

      clearPendingRequest(msg.requestId);

      chrome.tabs.sendMessage(req.tabId, {
        type: "X402_RESULT",
        requestId: req.inpageRequestId ?? req.id,
        approved: true,
        paymentHeader,
        txId,
      });
      return { paymentHeader, txId };
    }

    case "X402_REJECT": {
      const req = getPendingRequest(msg.requestId);
      if (req) {
        clearPendingRequest(msg.requestId);
        chrome.tabs.sendMessage(req.tabId, {
          type: "X402_RESULT",
          requestId: req.inpageRequestId ?? req.id,
          approved: false,
        });
      }
      return { success: true };
    }

    case "X402_GET_HISTORY":
      // Phase 2: payment history persistence is deferred; returns empty list for now.
      return { records: [] };

    // ── MPP avm payments ──────────────────────────────────────────────────────
    case "MPP_PAYMENT_NEEDED": {
      const requestId = await handleMpp({
        tabId: sender?.tab?.id ?? tabId,
        url: msg.url,
        method: msg.method,
        rawChallenge: msg.rawChallenge,
        inpageRequestId: msg.requestId,
      });
      return { requestId };
    }

    case "MPP_GET_PENDING": {
      const req = getPendingMppRequest(msg.requestId);
      return { request: req };
    }

    case "MPP_APPROVE": {
      const mppReq = getPendingMppRequest(msg.requestId);
      if (!mppReq) throw new Error("Pending MPP request not found");

      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet locked during MPP approval");
      }
      walletStore.resetAutoLock();

      // Check if active account is WalletConnect — route to WC signing
      const mppMeta = await walletStore.getMeta();
      const mppAccount = mppMeta.accounts.find((a) => a.id === mppMeta.activeAccountId);

      if (mppAccount?.type === "walletconnect") {
        const wcData = await buildMppPaymentTxnForWC(mppReq);
        return { needsWcSign: true, ...wcData };
      }

      // Vault account — sign locally
      const { authorizationHeader, txId } = await buildAndSignMppPayment(mppReq);
      clearPendingMppRequest(msg.requestId);

      // Notify the inpage script so it can retry the fetch with Authorization header
      chrome.tabs.sendMessage(mppReq.tabId, {
        type: "MPP_RESULT",
        requestId: mppReq.inpageRequestId ?? mppReq.id,
        approved: true,
        authorizationHeader,
        txId,
      });
      return { authorizationHeader, txId };
    }

    case "MPP_REJECT": {
      const mppReqToReject = getPendingMppRequest(msg.requestId);
      if (mppReqToReject) {
        clearPendingMppRequest(msg.requestId);
        chrome.tabs.sendMessage(mppReqToReject.tabId, {
          type: "MPP_RESULT",
          requestId: mppReqToReject.inpageRequestId ?? mppReqToReject.id,
          approved: false,
          error: "User rejected MPP payment",
        });
      }
      return { success: true };
    }

    case "MPP_WC_SIGNED": {
      const mppWcReq = getPendingMppRequest(msg.requestId);
      if (!mppWcReq) throw new Error("Pending MPP request not found");

      const avmReq = mppWcReq.avmRequest;
      const chain = resolveMppChain(avmReq.network);
      if (!chain) throw new Error(`Unsupported MPP network: ${avmReq.network}`);

      const signedBytes = base64ToBytes(msg.signedTxnB64);
      const txId = await submitTransaction(chain, signedBytes);
      await waitForConfirmation(chain, txId, 8);
      await waitForIndexed(chain, txId);

      const wcMppMeta = await walletStore.getMeta();
      const wcPayer = wcMppMeta.accounts.find((a) => a.id === wcMppMeta.activeAccountId)?.address;
      if (!wcPayer) throw new Error("Cannot determine payer address for MPP WC payment");

      const mppCredential = {
        challenge: mppWcReq.challenge,
        source: `did:pkh:avm:${avmReq.network}:${wcPayer}`,
        payload: {
          txId,
          transaction: btoa(String.fromCharCode(...signedBytes)),
        },
      };
      const authorizationHeader = serializeMppCredential(mppCredential);

      clearPendingMppRequest(msg.requestId);
      chrome.tabs.sendMessage(mppWcReq.tabId, {
        type: "MPP_RESULT",
        requestId: mppWcReq.inpageRequestId ?? mppWcReq.id,
        approved: true,
        authorizationHeader,
        txId,
      });
      return { authorizationHeader, txId };
    }

    // ── AP2 (Agent Payments Protocol) ────────────────────────────────────────
    case "AP2_PAYMENT_REQUEST": {
      const requestId = await handleAp2Payment({
        tabId: sender?.tab?.id ?? tabId,
        url: msg.url,
        cartMandate: msg.cartMandate,
        inpageRequestId: msg.requestId,
      });
      return { requestId };
    }

    case "AP2_GET_PENDING": {
      const ap2Req = getPendingAp2Request(msg.requestId);
      return { request: ap2Req };
    }

    case "AP2_APPROVE": {
      const ap2Req = getPendingAp2Request(msg.requestId);
      if (!ap2Req) throw new Error("Pending AP2 request not found");

      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet locked during AP2 approval");
      }
      walletStore.resetAutoLock();

      // Find a matching IntentMandate if available (first non-expired one)
      const intentMandates = await getIntentMandates();
      const nowAp2 = Date.now();
      const matchingIntent = intentMandates.find((m) => {
        if (m.network !== ap2Req.network) return false;
        if (m.address !== ap2Req.address) return false;
        if (m.intent_expiry) {
          const expiresAt = new Date(m.intent_expiry).getTime();
          if (!isNaN(expiresAt) && nowAp2 > expiresAt) return false;
        }
        return true;
      });

      // Enforce IntentMandate spending cap if currencies match
      if (matchingIntent?.max_amount && matchingIntent.currency) {
        const cartTotal = parseFloat(ap2Req.total.value);
        const cap = parseFloat(matchingIntent.max_amount);
        if (
          matchingIntent.currency.toUpperCase() === ap2Req.total.currency.toUpperCase() &&
          !isNaN(cartTotal) && !isNaN(cap) && cartTotal > cap
        ) {
          throw new Error(
            `CartMandate total ${ap2Req.total.value} ${ap2Req.total.currency} ` +
            `exceeds IntentMandate spending cap of ${matchingIntent.max_amount} ${matchingIntent.currency}`
          );
        }
      }

      // Re-verify CartMandate expiry at signing time (defense-in-depth; UI may race)
      if (ap2Req.expiry) {
        const expiresAt = new Date(ap2Req.expiry).getTime();
        if (!isNaN(expiresAt) && Date.now() > expiresAt) {
          throw new Error("CartMandate has expired — cannot sign PaymentMandate");
        }
      }

      // Build and sign the PaymentMandate using the stored CartMandate
      // (retained in PendingAp2Approval for correct hash computation)
      const paymentMandate = await buildPaymentMandate({
        cartMandate: ap2Req.cartMandate,
        intentMandateId: matchingIntent?.id ?? "",
        network: ap2Req.network,
        address: ap2Req.address,
      });

      clearPendingAp2Request(msg.requestId);
      resolveApproval(msg.requestId);

      // Notify the inpage script so its pending Promise can resolve
      chrome.tabs.sendMessage(ap2Req.tabId, {
        type: "AP2_RESULT",
        requestId: ap2Req.inpageRequestId ?? ap2Req.id,
        approved: true,
        paymentMandate,
      });
      return { paymentMandate };
    }

    case "AP2_REJECT": {
      const ap2ReqToReject = getPendingAp2Request(msg.requestId);
      if (ap2ReqToReject) {
        clearPendingAp2Request(msg.requestId);
        rejectApproval(msg.requestId, "User rejected AP2 payment credential");
        chrome.tabs.sendMessage(ap2ReqToReject.tabId, {
          type: "AP2_RESULT",
          requestId: ap2ReqToReject.inpageRequestId ?? ap2ReqToReject.id,
          approved: false,
          error: "User rejected AP2 payment credential",
        });
      }
      return { success: true };
    }

    case "AP2_LIST_INTENT_MANDATES": {
      const mandates = await getIntentMandates();
      return { mandates };
    }

    // ── WalletConnect Web3Wallet (AlgoVoi as wallet for AI agents) ───────────

    case "W3W_GENERATE_URI": {
      const uri = await generatePairingUri(WC_PROJECT_ID);
      return { uri };
    }

    case "W3W_GET_SESSIONS": {
      const sessions = getActiveSessions();
      return { sessions };
    }

    case "W3W_DISCONNECT": {
      await disconnectAgentSession(msg.topic);
      return { success: true };
    }

    case "W3W_AGENT_SIGN_GET_PENDING": {
      const agentReq = getPendingAgentSignRequest(msg.requestId);
      return { request: agentReq };
    }

    case "W3W_AGENT_SIGN_APPROVE": {
      const agentReq = getPendingAgentSignRequest(msg.requestId);
      if (!agentReq) throw new Error("Pending agent sign request not found");
      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet locked during agent sign approval");
      }
      walletStore.resetAutoLock();
      const agentMeta = await walletStore.getMeta();
      const agentAccount = agentMeta.accounts.find((a) => a.id === agentMeta.activeAccountId);
      if (!agentAccount || agentAccount.type === "walletconnect") {
        throw new Error("Agent signing requires a vault/mnemonic account");
      }
      const agentSk = await walletStore.getActiveSecretKey();
      const signedTxns = await approveAgentSignRequest(msg.requestId, agentSk, agentAccount.address);
      return { signedTxns };
    }

    case "W3W_AGENT_SIGN_REJECT": {
      await rejectAgentSignRequest(msg.requestId);
      return { success: true };
    }

    // ── enVoi name resolution ─────────────────────────────────────────────────
    case "VOI_RESOLVE_NAME": {
      // Guard: only available on Voi chain with an unlocked wallet
      const resolveMeta = await walletStore.getMeta();
      if (resolveMeta.activeChain !== "voi") {
        throw new Error("Name service is only available on the Voi chain");
      }
      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet is locked — unlock before resolving .voi names");
      }
      const { address, displayName } = await mcpResolveEnvoi(msg.name);
      return { address, displayName };
    }

    // ── Unified approval flow ─────────────────────────────────────────────────
    // Handled by approval-handler.ts; used by ARC-0027 and enVoi popups.

    case "APPROVAL_GET_PENDING": {
      const approval = getPendingApproval(msg.requestId);
      return { approval };
    }

    case "APPROVAL_APPROVE": {
      // Only settle if the request is still pending (idempotent if already gone)
      const approvalForApprove = getPendingApproval(msg.requestId);
      if (!approvalForApprove) {
        throw new Error("Approval request not found — it may have already been settled or timed out");
      }
      resolveApproval(msg.requestId);
      return { success: true };
    }

    case "APPROVAL_REJECT": {
      // Fail-open: don't throw if the request isn't found (popup may close late
      // after TTL already fired, or user double-clicked Reject).
      rejectApproval(msg.requestId, "User rejected the request");
      return { success: true };
    }

    default:
      throw new Error(`Unknown message type: ${(msg as { type: string }).type}`);
  }
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function broadcastLockState(): void {
  const lockState = walletStore.getLockState();
  // Ignore "Receiving end does not exist" when no extension pages are open.
  chrome.runtime.sendMessage({ type: "LOCK_STATE_CHANGED", lockState }).catch(() => {});
}

function broadcastChainChange(chain: ChainId): void {
  // Only send to tabs with http/https — chrome://, new-tab, and PDF renderers
  // don't have our content script and throw "No such renderer" if messaged.
  chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "CHAIN_CHANGED", chain }).catch(() => {});
      }
    }
  });
}
