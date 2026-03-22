/**
 * Standalone WalletConnect transaction signing — no React state required.
 *
 * Used by the x402 / MPP approval popup to sign payment transactions via an
 * existing WalletConnect session (Defly, Pera, Lute) without needing the
 * full useWalletConnect hook.
 *
 * Dead-session detection strategy (mirrors wc-sign-group.ts):
 *   1. restoreWCStorage() — repopulate localStorage from chrome.storage.local
 *      snapshot so SignClient finds the session after a lock/unlock wipe.
 *   2. Wait 1.5 s (SESSION_SETTLE_MS) for the relay to deliver any pending
 *      session_delete events the wallet sent while the popup was closed.
 *   3. client.session.get(topic) — throws if session was deleted/not found.
 *   4. Expiry timestamp check.
 *   5. Dispatch signing request with 2-minute timeout. The relay queues the
 *      request; opening Defly/Pera reconnects it and delivers the request.
 *      No pre-sign ping — see wc-sign-group.ts for the rationale.
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
import { restoreWCStorage } from "@shared/utils/wc-storage";
import type { ChainId } from "@shared/types/chain";

const RELAY_TIMEOUT_MS  = 20_000;
const SESSION_SETTLE_MS =  1_500;  // wait for relay to deliver pending session_delete
const PING_TIMEOUT_MS   = 10_000;  // 10 s — fast dead-session detection for time-sensitive payments
const SIGN_TIMEOUT_MS   = 90_000;  // 90 s — relay queues request; user opens wallet to approve

const RE_PAIR_MSG =
  "WalletConnect session is no longer active — your wallet disconnected.\n" +
  "Remove this account from AlgoVoi and re-pair via + Connect.";

/**
 * Sign an unsigned transaction (base64 msgpack) via an existing WalletConnect session.
 * Returns the signed transaction as a Uint8Array (raw msgpack bytes).
 *
 * Handles both flat [signedB64] and nested [[signedB64]] response formats
 * so it works with Pera, Defly, and other ARC-0025-compliant wallets.
 *
 * @param sessionTopic    WC session topic stored on the account (wcSessionTopic)
 * @param chain           "algorand" | "voi" — determines the CAIP-2 chain ID
 * @param unsignedTxnB64  base64(algosdk unsigned msgpack)
 * @param signerAddress   Algorand/Voi address that should sign
 */
export async function signTransactionWithWC(
  sessionTopic: string,
  chain: ChainId,
  unsignedTxnB64: string,
  signerAddress: string
): Promise<Uint8Array> {
  if (!WC_PROJECT_ID) {
    throw new Error(
      "WalletConnect Project ID is not configured.\n" +
      "Add VITE_WC_PROJECT_ID=<your-id> to .env"
    );
  }

  // ── 1. Restore session data ────────────────────────────────────────────────
  // Lock/unlock cycles wipe wc@2:* from localStorage. Restore the snapshot so
  // SignClient.init() finds the existing session.
  await restoreWCStorage();

  // ── 2. Connect to relay ────────────────────────────────────────────────────
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`Could not connect to WalletConnect relay after ${RELAY_TIMEOUT_MS / 1000}s`)),
      RELAY_TIMEOUT_MS
    )
  );

  const client = await Promise.race([
    SignClient.init({
      projectId: WC_PROJECT_ID,
      relayUrl: WC_RELAY_URL,
      metadata: {
        name: "AlgoVoi",
        description: "Web3 wallet for Algorand + Voi with x402 payments",
        url: WC_APP_URL,
        icons: [],
      },
    }),
    timeoutPromise,
  ]);

  // ── 3. Settle — let relay deliver pending session_delete events ────────────
  await new Promise<void>((r) => setTimeout(r, SESSION_SETTLE_MS));

  // ── 4. Verify session is still live ───────────────────────────────────────
  let sessionExpiry = 0;
  try {
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

  // ── 5. Ping — fast dead-session detection ─────────────────────────────────
  // x402 / MPP payments are time-sensitive. A 10 s ping catches dead sessions
  // immediately so the user can re-pair rather than waiting 90 s for timeout.
  // (Swap path in wc-sign-group.ts omits ping to avoid false positives for
  // temporarily-backgrounded wallets — swaps have a full re-pair UI.)
  try {
    await Promise.race([
      client.ping({ topic: sessionTopic }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("ping_timeout")), PING_TIMEOUT_MS)
      ),
    ]);
  } catch {
    throw new Error(RE_PAIR_MSG);
  }

  // ── 6. Dispatch signing request ────────────────────────────────────────────
  const wcChain = WC_CHAIN_ID[chain] ?? WC_CHAIN_ID["algorand"];

  // 2-minute timeout: the relay queues the request for delivery when the wallet
  // app reconnects. If nothing responds after 2 min the session is truly dead.
  const signTimeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(RE_PAIR_MSG)), SIGN_TIMEOUT_MS)
  );

  const result = await Promise.race([
    client.request<unknown>({
      topic: sessionTopic,
      chainId: wcChain,
      request: {
        method: WC_METHOD_SIGN_TXN,
        params: [[{ txn: unsignedTxnB64, signers: [signerAddress] }]],
      },
    }),
    signTimeoutPromise,
  ]);

  return extractWCSignedTxn(result);
}
