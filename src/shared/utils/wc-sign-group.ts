/**
 * Standalone WalletConnect indexed-group transaction signing.
 *
 * Mirrors wc-sign.ts exactly (fresh SignClient per call, no settle delay,
 * no session guard) — extended to handle multi-txn groups where only a subset
 * of transactions need the user's signature (e.g. Haystack swap groups).
 *
 * Used by SwapPanel for the WC signing path.
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
import algosdk from "algosdk";

const RELAY_TIMEOUT_MS = 20_000;

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

  // Race SignClient.init() against a timeout — the relay WebSocket can hang
  // silently in extension contexts (same guard as wc-sign.ts).
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `Could not connect to WalletConnect relay after ${RELAY_TIMEOUT_MS / 1000}s`
          )
        ),
      RELAY_TIMEOUT_MS
    )
  );

  console.log("[wc-sign-group] SignClient.init starting...");
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
  console.log("[wc-sign-group] SignClient ready — sending request to relay...");

  const wcChain = WC_CHAIN_ID[chain] ?? WC_CHAIN_ID["algorand"];

  // ARC-0025: send the full group; signers:[] = wallet skips (pre-signed txn).
  const txnParams = txns.map((txn, i) => ({
    txn: btoa(String.fromCharCode(...txn.toByte())),
    signers: indexesToSign.includes(i) ? [signerAddress] : [],
  }));

  // No timeout on client.request() — relay delivery + phone approval legitimately
  // exceeds 60–90 s. The relay timeout above covers relay connection only.
  console.log("[wc-sign-group] client.request dispatched — topic:", sessionTopic.slice(0, 16), "txns:", txns.length, "signing:", indexesToSign);
  const result = await client.request<unknown>({
    topic: sessionTopic,
    chainId: wcChain,
    request: { method: WC_METHOD_SIGN_TXN, params: [txnParams] },
  });

  console.log("[wc-sign-group] wallet responded — result type:", typeof result, Array.isArray(result) ? `array[${(result as unknown[]).length}]` : "");
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
