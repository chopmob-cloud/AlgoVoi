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
    authAddr: info.authAddr ?? undefined,
  };
}

export async function getSuggestedParams(chain: ChainId): Promise<algosdk.SuggestedParams> {
  return getAlgodClient(chain).getTransactionParams().do();
}

export async function submitTransaction(
  chain: ChainId,
  signedTxn: Uint8Array
): Promise<string> {
  const result = await getAlgodClient(chain).sendRawTransaction(signedTxn).do();
  return result.txId;
}

export async function submitTransactionGroup(
  chain: ChainId,
  signedTxns: Uint8Array[]
): Promise<string> {
  const combined = algosdk.concatArrays(...signedTxns);
  const result = await getAlgodClient(chain).sendRawTransaction(combined).do();
  return result.txId;
}

/** Wait for transaction confirmation (up to maxRounds) */
export async function waitForConfirmation(
  chain: ChainId,
  txId: string,
  maxRounds = 10
): Promise<algosdk.modelsv2.PendingTransactionResponse> {
  return algosdk.waitForConfirmation(getAlgodClient(chain), txId, maxRounds);
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
