/**
 * Algorand + Voi algosdk clients.
 * Both chains use identical algosdk surface — only the node URLs and genesis
 * hash differ. This module creates and caches client instances per-chain.
 */

import algosdk from "algosdk";
import { CHAINS } from "@shared/constants";
import type { ChainId, AccountState, AccountAsset } from "@shared/types/chain";

const _algodClients: Partial<Record<ChainId, algosdk.Algodv2>> = {};
const _indexerClients: Partial<Record<ChainId, algosdk.Indexer>> = {};

export function getAlgodClient(chain: ChainId): algosdk.Algodv2 {
  if (!_algodClients[chain]) {
    const cfg = CHAINS[chain].algod;
    _algodClients[chain] = new algosdk.Algodv2(cfg.token, cfg.url, cfg.port);
  }
  return _algodClients[chain]!;
}

export function getIndexerClient(chain: ChainId): algosdk.Indexer {
  if (!_indexerClients[chain]) {
    const cfg = CHAINS[chain].indexer;
    _indexerClients[chain] = new algosdk.Indexer(cfg.token, cfg.url, cfg.port);
  }
  return _indexerClients[chain]!;
}

export async function getAccountState(
  address: string,
  chain: ChainId
): Promise<AccountState> {
  const algod = getAlgodClient(chain);
  const info = await algod.accountInformation(address).do();
  const assets: AccountAsset[] = (info["assets"] as algosdk.modelsv2.AssetHolding[] ?? []).map(
    (h) => ({
      assetId: Number(h.assetId),
      name: "", // populated via indexer if needed
      unitName: "",
      decimals: 0,
      amount: h.amount,
      frozen: h.isFrozen,
    })
  );
  return {
    address,
    chain,
    balance: info.amount,
    assets,
    minBalance: info.minBalance,
    authAddr: info.authAddr != null ? String(info.authAddr) : undefined,
  };
}

/**
 * Simulate a transaction group to preview balance changes and detect failures
 * before the user signs. Uses algod's /v2/transactions/simulate endpoint.
 * Returns a simplified result safe for display in the approval popup.
 */
export async function simulateTransaction(
  chain: ChainId,
  unsignedTxnBytes: Uint8Array[]
): Promise<{
  wouldSucceed: boolean;
  failureMessage?: string;
  budgetConsumed?: number;
}> {
  try {
    const algod = getAlgodClient(chain);
    const request = new algosdk.modelsv2.SimulateRequest({
      txnGroups: [
        new algosdk.modelsv2.SimulateRequestTransactionGroup({
          txns: unsignedTxnBytes.map((b) => algosdk.decodeObj(b) as algosdk.EncodedSignedTransaction),
        }),
      ],
      allowEmptySignatures: true,
      allowUnnamedResources: true,
    });
    const result = await algod.simulateTransactions(request).do();
    const group = result.txnGroups?.[0];
    const failed = group?.failureMessage;
    return {
      wouldSucceed: !failed,
      failureMessage: failed ?? undefined,
      budgetConsumed: Number(group?.appBudgetConsumed ?? 0),
    };
  } catch {
    // Simulation failed (node unreachable, etc.) — don't block the user
    return { wouldSucceed: true };
  }
}

export async function getSuggestedParams(chain: ChainId): Promise<algosdk.SuggestedParams> {
  return getAlgodClient(chain).getTransactionParams().do();
}

export async function submitTransaction(
  chain: ChainId,
  signedTxn: Uint8Array
): Promise<string> {
  const result = await getAlgodClient(chain).sendRawTransaction(signedTxn).do();
  // algosdk v3: PostTransactionsResponse stores the id as `.txid` (lowercase)
  return result.txid;
}

export async function submitTransactionGroup(
  chain: ChainId,
  signedTxns: Uint8Array[]
): Promise<string> {
  const totalLength = signedTxns.reduce((acc, a) => acc + a.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of signedTxns) { combined.set(arr, offset); offset += arr.length; }
  const result = await getAlgodClient(chain).sendRawTransaction(combined).do();
  return result.txid;
}

/** Wait for transaction confirmation (up to maxRounds) */
export async function waitForConfirmation(
  chain: ChainId,
  txId: string,
  maxRounds = 10
): Promise<algosdk.modelsv2.PendingTransactionResponse> {
  return algosdk.waitForConfirmation(getAlgodClient(chain), txId, maxRounds);
}

/**
 * Poll the indexer until a transaction is indexed (visible to the server).
 * Must be called after waitForConfirmation so the tx is already on-chain.
 * Indexers can lag several seconds behind algod even after block confirmation.
 */
export async function waitForIndexed(
  chain: ChainId,
  txId: string,
  maxAttempts = 20,
  intervalMs = 1000
): Promise<void> {
  const indexer = getIndexerClient(chain);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await indexer.lookupTransactionByID(txId).do();
      return; // indexed
    } catch {
      // 404 — not indexed yet; wait and retry
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  // Best-effort: proceed anyway — server may still reject with tx_not_found
}

/** Check if an account has opted in to a given ASA */
export async function hasOptedIn(
  chain: ChainId,
  address: string,
  asaId: number
): Promise<boolean> {
  try {
    const state = await getAccountState(address, chain);
    return state.assets.some((a) => a.assetId === asaId);
  } catch {
    return false;
  }
}

/** Build an opt-in transaction for an ASA */
export async function buildOptInTxn(
  chain: ChainId,
  address: string,
  asaId: number
): Promise<algosdk.Transaction> {
  const params = await getSuggestedParams(chain);
  return algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    assetIndex: asaId,
    amount: 0,
    suggestedParams: params,
  });
}
