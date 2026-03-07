export type ChainId = "algorand" | "voi";

export interface ChainConfig {
  id: ChainId;
  name: string;
  ticker: string;
  decimals: number;
  genesisId: string;
  genesisHash: string;
  algod: { url: string; token: string; port: number };
  indexer: { url: string; token: string; port: number };
  explorer: string;
  x402Network: string;
  /** Native ASA used for x402 exact-scheme (undefined = native coin) */
  defaultPaymentAsset?: { asaId: number; ticker: string; decimals: number };
}

export interface AssetInfo {
  id: number; // 0 = native coin
  name: string;
  unitName: string;
  decimals: number;
  total?: bigint;
  url?: string;
  frozen?: boolean;
}

export interface AccountAsset {
  assetId: number;
  name: string;
  unitName: string;
  decimals: number;
  amount: bigint;
  frozen: boolean;
}

export interface AccountState {
  address: string;
  chain: ChainId;
  balance: bigint; // microALGO / microVOI
  assets: AccountAsset[];
  minBalance: bigint;
  authAddr?: string; // if rekeyed
}
