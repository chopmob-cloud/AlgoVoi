import type { ChainConfig } from "./types/chain";

export const CHAINS: Record<string, ChainConfig> = {
  algorand: {
    id: "algorand",
    name: "Algorand",
    ticker: "ALGO",
    decimals: 6,
    genesisId: "mainnet-v1.0",
    // Algorand mainnet genesis hash (verified)
    genesisHash: "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    algod: {
      url: import.meta.env.VITE_ALGORAND_NODE_URL ?? "https://mainnet-api.algonode.cloud",
      token: "",
      port: 443,
    },
    indexer: {
      url: import.meta.env.VITE_ALGORAND_INDEXER_URL ?? "https://mainnet-idx.algonode.cloud",
      token: "",
      port: 443,
    },
    explorer: "https://allo.info",
    x402Network: "algorand-mainnet",
    defaultPaymentAsset: {
      asaId: 31566704, // USDC on Algorand mainnet
      ticker: "USDC",
      decimals: 6,
    },
  },
  voi: {
    id: "voi",
    name: "Voi",
    ticker: "VOI",
    decimals: 6,
    genesisId: "voimain-v1.0",
    // Verified from mainnet-api.voi.nodely.dev/v2/blocks/0 → block.gh field
    genesisHash: "r20fSQI8gWe/kFZziNonSPCXLwcQmH/nxROvnnueWOk=",
    algod: {
      url: import.meta.env.VITE_VOI_NODE_URL ?? "https://mainnet-api.voi.nodely.dev",
      token: "",
      port: 443,
    },
    indexer: {
      url: import.meta.env.VITE_VOI_INDEXER_URL ?? "https://mainnet-idx.voi.nodely.dev",
      token: "",
      port: 443,
    },
    explorer: "https://voi.observer",
    x402Network: "voi-mainnet",
    defaultPaymentAsset: {
      asaId: 302190, // aUSDC on Voi mainnet
      ticker: "aUSDC",
      decimals: 6,
    },
  },
};

/** Message channel identifiers */
export const MSG_SOURCE_INPAGE = "algovou-inpage" as const;
export const MSG_SOURCE_CONTENT = "algovou-content" as const;

/** window.algorand provider version */
export const PROVIDER_VERSION = "0.1.0";
export const PROVIDER_ID = "algovou";

/** x402 spec version this client implements */
export const X402_VERSION = 1;

/**
 * x402 HTTP header names (from the official spec / coinbase/x402 README).
 *   PAYMENT-REQUIRED  — 402 response header; base64(PaymentRequired JSON)
 *   PAYMENT-SIGNATURE — client retry header;  base64(X402PaymentPayload JSON)
 *   PAYMENT-RESPONSE  — 200 response header;  base64(SettlementResponse JSON)
 */
export const HEADER_PAYMENT_REQUIRED  = "PAYMENT-REQUIRED"  as const;
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE" as const;
export const HEADER_PAYMENT_RESPONSE  = "PAYMENT-RESPONSE"  as const;

/** Storage keys */
export const STORAGE_KEY_VAULT = "algovou_vault";
export const STORAGE_KEY_META = "algovou_meta";

/** Auto-lock timeout in minutes */
export const DEFAULT_AUTO_LOCK_MINUTES = 15;

// ── WalletConnect v2 ──────────────────────────────────────────────────────────

/** Register a free project ID at https://cloud.walletconnect.com */
export const WC_PROJECT_ID = (import.meta.env.VITE_WC_PROJECT_ID as string | undefined) ?? "";

/** WalletConnect relay WebSocket URL */
export const WC_RELAY_URL = "wss://relay.walletconnect.com";

/**
 * Public-facing HTTPS URL for this extension (used in WalletConnect dApp metadata).
 * Must be https:// — mobile wallets validate and may reject chrome-extension:// URLs.
 * Override via VITE_WC_APP_URL in .env.
 */
export const WC_APP_URL =
  (import.meta.env.VITE_WC_APP_URL as string | undefined) ?? "https://algovou.app";

/**
 * Algorand mainnet CAIP-2 chain ID.
 * Derived from the first 32 chars of the base64url-encoded genesis hash.
 * Used by Pera Wallet, Defly, and Lute on Algorand.
 */
export const WC_ALGORAND_MAINNET_CHAIN = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k" as const;

/**
 * Voi mainnet CAIP-2 chain ID.
 * Derived from the first 32 chars of the base64url-encoded Voi genesis hash.
 * Genesis hash (verified): r20fSQI8gWe/kFZziNonSPCXLwcQmH/nxROvnnueWOk=
 * base64url → strip padding, / → _: r20fSQI8gWe_kFZziNonSPCXLwcQmH_nxROvnnueWOk
 * First 32 chars: r20fSQI8gWe_kFZziNonSPCXLwcQmH_n
 */
export const WC_VOI_MAINNET_CHAIN = "algorand:r20fSQI8gWe_kFZziNonSPCXLwcQmH_n" as const;

/** Convenience map: chain id → WC CAIP-2 chain string */
export const WC_CHAIN_ID: Record<string, string> = {
  algorand: WC_ALGORAND_MAINNET_CHAIN,
  voi:      WC_VOI_MAINNET_CHAIN,
};

/** The AVM signing method used by Pera, Defly, Lute, and ARC-0025-compliant wallets */
export const WC_METHOD_SIGN_TXN = "algo_signTxn" as const;

/** PBKDF2 iterations for wallet encryption */
export const PBKDF2_ITERATIONS = 600_000;

/** Approval popup dimensions */
export const APPROVAL_POPUP_WIDTH = 400;
export const APPROVAL_POPUP_HEIGHT = 620;

/**
 * chrome.storage.local key that holds the tab ID of an open WC pairing tab.
 * Used to prevent multiple simultaneous pairing tabs and to re-focus an
 * existing tab instead of opening a duplicate.
 * Written by AccountView when a tab is created; removed by WalletConnectModal
 * after the account is saved and the tab closes itself via window.close().
 */
export const WC_PAIR_TAB_KEY = "wc_pair_tab_id" as const;
