import type { ChainId } from "./chain";

export type AccountType = "mnemonic" | "walletconnect" | "ledger" | "watch";

export interface Account {
  id: string; // uuid
  name: string;
  address: string;
  type: AccountType;
  /** WalletConnect v2 session topic (walletconnect accounts only) */
  wcSessionTopic?: string;
  /** Display name of the connected wallet app, e.g. "Pera Wallet" */
  wcPeerName?: string;
}

/** The plaintext vault stored in memory only when unlocked */
export interface VaultData {
  accounts: Array<{
    id: string;
    address: string;
    mnemonic: string; // 25-word Algorand mnemonic (identical format for both chains)
  }>;
  /**
   * H2: origin → approved addresses mapping, moved from WalletMeta into the
   * encrypted vault so the browsing-history correlation is protected at rest.
   * Optional for backward-compatibility; migrated from meta on first unlock.
   */
  connectedSites?: Record<string, string[]>;
}

/** AES-GCM encrypted vault persisted in chrome.storage.local */
export interface EncryptedVault {
  salt: string; // hex-encoded 32 bytes (PBKDF2 salt)
  iv: string;   // hex-encoded 12 bytes (AES-GCM nonce)
  ciphertext: string; // hex-encoded ciphertext
}

/** Unencrypted metadata persisted in chrome.storage.local */
export interface WalletMeta {
  accounts: Account[];
  activeAccountId: string | null;
  activeChain: ChainId;
  /**
   * @deprecated — moved to encrypted VaultData (H2). Kept here for a one-time
   * migration only; no longer updated after the first unlock post-upgrade.
   * origin → array of account addresses that have approved.
   */
  connectedSites?: Record<string, string[]>;
  /** Whether the wallet has been initialised */
  initialized: boolean;
  /**
   * M5: Per-user spending caps for automatic x402 payments.
   * Defaults to 10 ALGO/USDC (10_000_000 micro-units) if not set.
   */
  spendingCaps?: {
    /** Maximum native coin (ALGO/VOI) per auto-payment, in micro-units */
    nativeMicrounits: number;
    /** Maximum ASA token (USDC/aUSDC) per auto-payment, in micro-units */
    asaMicrounits: number;
  };
}

export interface WalletStore {
  meta: WalletMeta;
  vault: EncryptedVault | null;
}

export type LockState = "locked" | "unlocked" | "uninitialized";
