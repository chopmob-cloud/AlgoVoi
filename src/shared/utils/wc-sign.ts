/**
 * Standalone WalletConnect transaction signing — no React state required.
 *
 * Used by the x402 approval popup to sign payment transactions via an
 * existing WalletConnect session (e.g. Defly, Pera) without needing the
 * full useWalletConnect hook.
 *
 * Reuses the existing WC session already stored in extension localStorage
 * from the pairing flow — no new QR scan needed.
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
import type { ChainId } from "@shared/types/chain";

const RELAY_TIMEOUT_MS   = 20_000;
const REQUEST_TIMEOUT_MS = 90_000; // 90 s — mobile wallet must be open and connected

/**
 * Sign an unsigned transaction (base64 msgpack) via an existing WalletConnect session.
 * Returns the signed transaction as a Uint8Array (raw msgpack bytes).
 *
 * Handles both flat [signedB64] and nested [[signedB64]] response formats
 * so it works with Pera, Defly, and other ARC-0025-compliant wallets.
 *
 * @param sessionTopic  WC session topic stored on the account (wcSessionTopic)
 * @param chain         "algorand" | "voi" — determines the CAIP-2 chain ID
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

  // Race SignClient.init() against a timeout — the relay WebSocket can hang
  // silently in extension contexts.
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

  const wcChain = WC_CHAIN_ID[chain] ?? WC_CHAIN_ID["algorand"];

  // ARC-0025 / Pera/Defly format: array of transaction groups.
  // Use `unknown` — Defly may return [[string]] (nested) instead of [string] (flat).
  const result = await Promise.race([
    client.request<unknown>({
      topic: sessionTopic,
      chainId: wcChain,
      request: {
        method: WC_METHOD_SIGN_TXN,
        params: [[{ txn: unsignedTxnB64, signers: [signerAddress] }]],
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(
          `WalletConnect signing timed out after ${REQUEST_TIMEOUT_MS / 1000}s. ` +
          `Make sure your wallet app is open and connected.`
        )),
        REQUEST_TIMEOUT_MS
      )
    ),
  ]);

  return extractWCSignedTxn(result);
}
