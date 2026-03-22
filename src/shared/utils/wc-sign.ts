/**
 * Standalone WalletConnect transaction signing — no React state required.
 *
 * Used by the x402 / MPP approval popup to sign payment transactions via an
 * existing WalletConnect session (Defly, Pera, Lute) without needing the
 * full useWalletConnect hook.
 *
 * Storage: uses chrome.storage.local via the chromeStorage adapter instead
 * of localStorage. Session data survives lock/unlock cycles, SW suspension,
 * and browser restarts without any snapshot/restore mechanism.
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

const RELAY_TIMEOUT_MS  = 20_000;
const SESSION_SETTLE_MS =  1_500;
const SIGN_TIMEOUT_MS   = 90_000;

const RE_PAIR_MSG =
  "WalletConnect session is no longer active — your wallet disconnected.\n" +
  "Remove this account from AlgoVoi and re-pair via + Connect.";

/**
 * Sign an unsigned transaction (base64 msgpack) via an existing WalletConnect session.
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

  // ── 1. Connect to relay (chrome.storage.local adapter — no restore needed) ──
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
      storage: chromeStorage,
      metadata: {
        name: "AlgoVoi",
        description: "Web3 wallet for Algorand + Voi with x402 payments",
        url: WC_APP_URL,
        icons: [],
      },
    }),
    timeoutPromise,
  ]);

  // ── 2. Settle — let relay deliver pending session_delete events ────────────
  await new Promise<void>((r) => setTimeout(r, SESSION_SETTLE_MS));

  // ── 3. Verify session is still live ───────────────────────────────────────
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

  // ── 4. Dispatch signing request ────────────────────────────────────────────
  const wcChain = WC_CHAIN_ID[chain] ?? WC_CHAIN_ID["algorand"];

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
