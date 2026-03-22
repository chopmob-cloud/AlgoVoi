/**
 * Standalone WalletConnect indexed-group transaction signing.
 *
 * Used by SwapPanel for the WC signing path.
 *
 * Dead-session detection strategy:
 *   1. After SignClient.init(), wait 1.5 s so the relay can deliver any
 *      pending `session_delete` messages the wallet app sent when it
 *      disconnected. The client processes them and removes the session from
 *      localStorage.
 *   2. Call client.session.get(topic) — throws if the session was removed.
 *   3. Check the session expiry timestamp.
 *   4. Dispatch the signing request with a 2-minute timeout. The relay queues
 *      the request; when the user opens Defly/Pera it reconnects to the relay
 *      and receives the pending request. If nothing responds within 2 min the
 *      session is truly dead and we surface the re-pair message.
 *
 * Why no ping:
 *   A pre-sign wc_ping was removed because it caused false "Wallet disconnected"
 *   errors. After 30+ min idle, iOS/Android battery optimisation drops Defly's
 *   relay WebSocket. The ping timed out (8 s) and flagged the session as dead
 *   even though the WC session itself was still cryptographically valid. Opening
 *   Defly reconnects it to the relay and delivers the queued request — so the
 *   ping was an unnecessary blocker. session.get() + expiry check catch true
 *   staleness (session deleted/expired); the 2-min request timeout catches the
 *   rare phone-reboot case where session_delete was never sent.
 */

import SignClient from "@walletconnect/sign-client";
import {
  WC_PROJECT_ID,
  WC_RELAY_URL,
  WC_APP_URL,
  WC_CHAIN_ID,
  WC_METHOD_SIGN_TXN,
} from "@shared/constants";
import { extractWCSignedTxn } from "@shared/utils/crypto";
import { chromeStorage } from "@shared/utils/wc-chrome-storage";
import type { ChainId } from "@shared/types/chain";
import algosdk from "algosdk";

const RELAY_TIMEOUT_MS  = 20_000;
const SESSION_SETTLE_MS = 1_500;   // time for relay to deliver pending session_delete events
const SIGN_TIMEOUT_MS   = 120_000; // 2 min — relay queues request; user opens Defly to approve

const RE_PAIR_MSG =
  "WalletConnect session is no longer active — your wallet disconnected.\n" +
  "Remove this account from AlgoVoi and re-pair via + Connect.";

/**
 * Sign a transaction group via WalletConnect where only indexed slots need
 * the user's signature. Transactions NOT in indexesToSign are sent with
 * `signers: []` so the wallet knows they are pre-signed (logic-sigs / fees).
 *
 * Returns a parallel array: Uint8Array for signed slots, null for skipped.
 */
export async function signGroupIndexedWithWC(
  sessionTopic: string,
  chain: ChainId,
  txns: algosdk.Transaction[],
  indexesToSign: number[],
  signerAddress: string
): Promise<(Uint8Array | null)[]> {
  if (!WC_PROJECT_ID) {
    throw new Error(
      "WalletConnect Project ID is not configured.\n" +
      "Add VITE_WC_PROJECT_ID=<your-id> to .env"
    );
  }

  // ── 1. Connect to relay ────────────────────────────────────────────────────
  const relayTimeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Could not connect to WalletConnect relay after ${RELAY_TIMEOUT_MS / 1000}s`)),
      RELAY_TIMEOUT_MS
    )
  );

  console.log("[wc-sign-group] SignClient.init starting...");
  const client = await Promise.race([
    SignClient.init({
      projectId: WC_PROJECT_ID,
      relayUrl:  WC_RELAY_URL,
      storage:   chromeStorage,
      metadata: {
        name: "AlgoVoi",
        description: "Web3 wallet for Algorand + Voi with x402 payments",
        url: WC_APP_URL,
        icons: [],
      },
    }),
    relayTimeoutPromise,
  ]);

  // ── 2. Settle: let relay deliver pending session_delete / session_expire ───
  // When a Defly/Pera user disconnects from their app, the wallet sends a
  // session_delete message to the relay. If the extension was closed at that
  // moment it missed the event. On reconnect the relay replays pending
  // messages; this delay gives the client time to process them and remove
  // the dead session from localStorage before we check it.
  await new Promise<void>((r) => setTimeout(r, SESSION_SETTLE_MS));
  console.log("[wc-sign-group] SignClient ready — checking session...");

  // ── 3. Verify session is still live ───────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sessionExpiry = 0;
  try {
    // client.session.get() throws if the topic is not in the local store
    // (e.g. session_delete was just processed in the settle window above).
    const s = client.session.get(sessionTopic) as { expiry?: number };
    sessionExpiry = s.expiry ?? 0;
  } catch {
    throw new Error(RE_PAIR_MSG);
  }

  if (sessionExpiry > 0 && Math.floor(Date.now() / 1000) > sessionExpiry) {
    throw new Error(
      "WalletConnect session has expired.\n" +
      "Remove this account from AlgoVoi and re-pair via + Connect."
    );
  }

  // ── 4. Build and dispatch signing request ─────────────────────────────────
  const wcChain = WC_CHAIN_ID[chain] ?? WC_CHAIN_ID["algorand"];

  // ARC-0025: send the full group; signers:[] = wallet skips (pre-signed txn).
  const txnParams = txns.map((txn, i) => ({
    txn: btoa(String.fromCharCode(...txn.toByte())),
    signers: indexesToSign.includes(i) ? [signerAddress] : [],
  }));

  console.log(
    "[wc-sign-group] dispatching request — topic:", sessionTopic.slice(0, 16),
    "txns:", txns.length, "signing:", indexesToSign
  );

  // 2-minute timeout: swap requires the wallet app to be open (push notifications
  // don't fire for extension origins). If nothing responds after 2 min the
  // session is dead on the relay side — surface a re-pair message.
  const signTimeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(RE_PAIR_MSG)),
      SIGN_TIMEOUT_MS
    )
  );

  const result = await Promise.race([
    client.request<unknown>({
      topic:   sessionTopic,
      chainId: wcChain,
      request: { method: WC_METHOD_SIGN_TXN, params: [txnParams] },
    }),
    signTimeoutPromise,
  ]);

  console.log(
    "[wc-sign-group] wallet responded — result:",
    typeof result, Array.isArray(result) ? `array[${(result as unknown[]).length}]` : ""
  );

  // ── 5. Decode signed bytes ─────────────────────────────────────────────────
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
}
