/**
 * Persistent ASA metadata cache — chrome.storage.local.
 *
 * ASA name, unitName, and decimals are immutable after creation, so this
 * cache never needs to expire. Balances are always fetched live from algod.
 *
 * Structure:
 *   algovou_asset_cache = {
 *     algorand: { "31566704": { name, unitName, decimals }, … },
 *     voi:      { "302190":  { name, unitName, decimals }, … },
 *   }
 */

import { STORAGE_KEY_ASSET_CACHE } from "@shared/constants";

export interface AssetMeta {
  name: string;
  unitName: string;
  decimals: number;
}

type ChainCache = Record<string, AssetMeta>; // key = assetId.toString()
type FullCache  = Record<string, ChainCache>; // key = chain id

async function readFullCache(): Promise<FullCache> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY_ASSET_CACHE, (result) => {
      resolve((result[STORAGE_KEY_ASSET_CACHE] as FullCache | undefined) ?? {});
    });
  });
}

/** Read cached metadata for a specific chain. */
export async function readAssetCache(chain: string): Promise<ChainCache> {
  const full = await readFullCache();
  return full[chain] ?? {};
}

/**
 * Merge new entries into the cache for a given chain.
 * Existing entries are never overwritten — they are immutable on-chain.
 */
export async function writeAssetCache(
  chain: string,
  entries: Record<number, AssetMeta>
): Promise<void> {
  const full = await readFullCache();
  const existing = full[chain] ?? {};
  const merged: ChainCache = { ...existing };
  for (const [id, meta] of Object.entries(entries)) {
    // Only write if not already cached — params are immutable
    if (!merged[id]) merged[id] = meta;
  }
  full[chain] = merged;
  // W2: handle storage errors internally so callers don't need to
  chrome.storage.local.set({ [STORAGE_KEY_ASSET_CACHE]: full }, () => {
    if (chrome.runtime.lastError) {
      console.warn("[AlgoVoi] asset-cache write failed:", chrome.runtime.lastError.message);
    }
  });
}
