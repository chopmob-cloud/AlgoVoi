/**
 * Encrypted wallet store — the authoritative state of the extension.
 *
 * Persistence layers:
 *   chrome.storage.local → EncryptedVault  (AES-GCM ciphertext, never plaintext)
 *   chrome.storage.local → WalletMeta      (account list, active account, etc.)
 *   In-memory only       → VaultData       (decrypted keys, cleared on lock)
 *   In-memory only       → SessionKey      (CryptoKey + salt, cleared on lock)
 *
 * Session-key pattern:
 *   unlock() runs PBKDF2 once → stores { CryptoKey, saltHex } in _sessionKey.
 *   Every subsequent vault mutation calls _persistVaultData() which re-encrypts
 *   with the same key + a fresh IV. No password stored anywhere after unlock.
 */

import algosdk from "algosdk";
import {
  encryptVault,
  decryptVault,
  reEncryptVault,
  randomId,
} from "@shared/utils/crypto";
import {
  STORAGE_KEY_VAULT,
  STORAGE_KEY_META,
  DEFAULT_AUTO_LOCK_MINUTES,
} from "@shared/constants";
import type {
  Account,
  EncryptedVault,
  VaultData,
  WalletMeta,
  LockState,
} from "@shared/types/wallet";
import type { ChainId } from "@shared/types/chain";

// ── In-memory runtime state (never written to storage) ────────────────────────

let _vaultData: VaultData | null = null;

/** Held in memory for the duration of the unlocked session */
interface SessionKey { key: CryptoKey; saltHex: string }
let _sessionKey: SessionKey | null = null;

let _lockTimer: ReturnType<typeof setTimeout> | null = null;

// ── Vault mutation mutex ───────────────────────────────────────────────────────
// Prevents concurrent writes that could corrupt the encrypted vault.
// Each call to withVaultLock() queues behind the previous one.

let _vaultLockChain: Promise<void> = Promise.resolve();

async function withVaultLock<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  // Queue this operation after whatever is already running
  const prev = _vaultLockChain;
  _vaultLockChain = new Promise<void>((res) => { release = res; });
  await prev; // wait for the previous operation to finish
  try {
    return await fn();
  } finally {
    release(); // allow the next queued operation to proceed
  }
}

// ── Service-worker suspend cleanup ────────────────────────────────────────────
// The MV3 service worker can be suspended at any time. Wipe sensitive in-memory
// state on suspend so it is never serialised to disk by the browser engine.
chrome.runtime.onSuspend.addListener(() => {
  _vaultData  = null;
  _sessionKey = null;
  if (_lockTimer) { clearTimeout(_lockTimer); _lockTimer = null; }
});

// ── Storage helpers ───────────────────────────────────────────────────────────

function defaultMeta(): WalletMeta {
  return {
    accounts: [],
    activeAccountId: null,
    activeChain: "algorand",
    initialized: false,
  };
}

async function loadMeta(): Promise<WalletMeta> {
  const result = await chrome.storage.local.get(STORAGE_KEY_META);
  return (result[STORAGE_KEY_META] as WalletMeta | undefined) ?? defaultMeta();
}

async function saveMeta(meta: WalletMeta): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_META]: meta });
}

async function loadEncryptedVault(): Promise<EncryptedVault | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY_VAULT);
  return (result[STORAGE_KEY_VAULT] as EncryptedVault | undefined) ?? null;
}

async function saveEncryptedVault(vault: EncryptedVault): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_VAULT]: vault });
}

// ── Auto-lock ─────────────────────────────────────────────────────────────────

function startAutoLockTimer() {
  if (_lockTimer) clearTimeout(_lockTimer);
  _lockTimer = setTimeout(
    () => walletStore.lock(),
    DEFAULT_AUTO_LOCK_MINUTES * 60 * 1000
  );
}

function clearAutoLockTimer() {
  if (_lockTimer) { clearTimeout(_lockTimer); _lockTimer = null; }
}

// ── Vault persistence (uses session key — no password required) ───────────────

async function persistVaultData(): Promise<void> {
  return withVaultLock(async () => {
    if (!_vaultData)  throw new Error("Cannot persist: wallet is locked");
    if (!_sessionKey) throw new Error("Cannot persist: session key missing");
    const vault = await reEncryptVault(
      JSON.stringify(_vaultData),
      _sessionKey.key,
      _sessionKey.saltHex
    );
    await saveEncryptedVault(vault);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

export const walletStore = {

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  getLockState(): LockState {
    return _vaultData !== null ? "unlocked" : "locked";
  },

  async isInitialized(): Promise<boolean> {
    const meta = await loadMeta();
    return meta.initialized;
  },

  /**
   * Initialise a brand-new wallet.
   *
   * - Pass `mnemonic` (or omit) to create/import a mnemonic account as the
   *   first account (classic flow).
   * - Pass `mnemonic: null` to create an **empty vault** (WalletConnect-only
   *   setup flow). No mnemonic account is created; the user connects a mobile
   *   wallet in the next step instead.
   *
   * Leaves the wallet in the unlocked state.
   */
  async initialize(
    password: string,
    mnemonic?: string | null
  ): Promise<{ account: Account | null }> {
    if (mnemonic === null) {
      // ── Empty-vault init (WalletConnect / watch-only setup) ──────────────
      // H2: connectedSites lives in the encrypted vault, not in plaintext meta
      _vaultData = { accounts: [], connectedSites: {} };
      const { vault, key } = await encryptVault(JSON.stringify(_vaultData), password);
      _sessionKey = { key, saltHex: vault.salt };
      await saveEncryptedVault(vault);

      const meta: WalletMeta = {
        accounts: [],
        activeAccountId: null,
        activeChain: "algorand",
        initialized: true,
      };
      await saveMeta(meta);
      startAutoLockTimer();
      return { account: null };
    }

    // ── Mnemonic init (create new or import) ─────────────────────────────
    const mn = mnemonic ?? algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
    const kp = algosdk.mnemonicToSecretKey(mn);
    const id = randomId();
    const address = kp.addr.toString();
    const account: Account = { id, name: "Account 1", address, type: "mnemonic" };

    // H2: connectedSites lives in the encrypted vault, not in plaintext meta
    _vaultData = { accounts: [{ id, address, mnemonic: mn }], connectedSites: {} };

    // encryptVault returns the derived CryptoKey so we can keep it as the session key
    const { vault, key } = await encryptVault(JSON.stringify(_vaultData), password);
    _sessionKey = { key, saltHex: vault.salt };
    await saveEncryptedVault(vault);

    const meta: WalletMeta = {
      accounts: [account],
      activeAccountId: id,
      activeChain: "algorand",
      initialized: true,
    };
    await saveMeta(meta);
    startAutoLockTimer();
    return { account };
  },

  async unlock(password: string): Promise<void> {
    const vault = await loadEncryptedVault();
    if (!vault) throw new Error("No vault found — wallet not initialized");
    // decryptVault runs PBKDF2 once and returns both plaintext + the derived key
    const { plaintext, key } = await decryptVault(vault, password);
    _vaultData  = JSON.parse(plaintext) as VaultData;
    _sessionKey = { key, saltHex: vault.salt };

    // H2: One-time migration — move connectedSites from plaintext meta into the vault.
    // If the vault already has connectedSites (new wallet or already migrated), skip.
    if (!_vaultData.connectedSites) {
      const meta = await loadMeta();
      _vaultData.connectedSites = meta.connectedSites ?? {};
      await persistVaultData(); // re-encrypt with migrated data
    }

    startAutoLockTimer();
  },

  lock(): void {
    _vaultData  = null;
    _sessionKey = null;
    clearAutoLockTimer();
  },

  /** Extend auto-lock timer on any user activity */
  resetAutoLock(): void {
    if (_vaultData) startAutoLockTimer();
  },

  // ── Account management ─────────────────────────────────────────────────────

  async createAccount(name: string): Promise<Account> {
    if (!_vaultData) throw new Error("Wallet is locked");
    const mn      = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
    const kp      = algosdk.mnemonicToSecretKey(mn);
    const id      = randomId();
    const address = kp.addr.toString();
    _vaultData.accounts.push({ id, address, mnemonic: mn });
    await persistVaultData();                            // ✅ real persistence
    const account: Account = { id, name, address, type: "mnemonic" };
    const meta = await loadMeta();
    meta.accounts.push(account);
    if (!meta.activeAccountId) meta.activeAccountId = id;
    await saveMeta(meta);
    return account;
  },

  async importAccount(name: string, mnemonic: string): Promise<Account> {
    if (!_vaultData) throw new Error("Wallet is locked");
    const trimmed = mnemonic.trim();
    const kp      = algosdk.mnemonicToSecretKey(trimmed); // throws on invalid mnemonic
    const id      = randomId();
    const address = kp.addr.toString();
    _vaultData.accounts.push({ id, address, mnemonic: trimmed });
    await persistVaultData();
    const account: Account = { id, name, address, type: "mnemonic" };
    const meta = await loadMeta();
    meta.accounts.push(account);
    await saveMeta(meta);
    return account;
  },

  /**
   * Add a WalletConnect-linked account. No mnemonic is stored — the private
   * key stays on the user's phone. The account is recorded only in WalletMeta.
   * Wallet does NOT need to be unlocked to add a WC account.
   */
  async addWCAccount(
    name: string,
    address: string,
    sessionTopic: string,
    peerName: string,
    chain?: ChainId
  ): Promise<Account> {
    // M3: Validate the address before storing it. A compromised WC relay could
    // send a malformed address; this ensures only valid Algorand addresses are saved.
    if (!algosdk.isValidAddress(address)) {
      throw new Error("Invalid Algorand address — cannot add WalletConnect account");
    }
    const id = randomId();
    const account: Account = {
      id,
      name,
      address,
      type: "walletconnect",
      wcSessionTopic: sessionTopic,
      wcPeerName: peerName,
      ...(chain ? { wcChain: chain } : {}),
    };
    const meta = await loadMeta();
    meta.accounts.push(account);
    if (!meta.activeAccountId) meta.activeAccountId = id;
    await saveMeta(meta);
    return account;
  },

  async removeAccount(id: string): Promise<void> {
    if (!_vaultData) throw new Error("Wallet is locked");
    // WC accounts are not in the vault — only remove if present to avoid dirty persist
    const wasInVault = _vaultData.accounts.some((a) => a.id === id);
    if (wasInVault) {
      _vaultData.accounts = _vaultData.accounts.filter((a) => a.id !== id);
      await persistVaultData();
    }
    const meta = await loadMeta();
    meta.accounts = meta.accounts.filter((a) => a.id !== id);
    if (meta.activeAccountId === id) {
      meta.activeAccountId = meta.accounts[0]?.id ?? null;
    }
    await saveMeta(meta);
  },

  async renameAccount(id: string, name: string): Promise<void> {
    const meta = await loadMeta();
    const account = meta.accounts.find((a) => a.id === id);
    if (account) account.name = name;
    await saveMeta(meta);
  },

  async setActiveAccount(id: string): Promise<void> {
    const meta = await loadMeta();
    if (!meta.accounts.find((a) => a.id === id)) throw new Error("Account not found");
    meta.activeAccountId = id;
    await saveMeta(meta);
  },

  async setActiveChain(chain: ChainId): Promise<void> {
    const meta = await loadMeta();
    meta.activeChain = chain;
    await saveMeta(meta);
  },

  async getMeta(): Promise<WalletMeta> {
    return loadMeta();
  },

  /** Get the secret key for the active account (wallet must be unlocked) */
  async getActiveSecretKey(): Promise<Uint8Array> {
    if (!_vaultData) throw new Error("Wallet is locked");
    const meta = await loadMeta();
    const vaultAccount = _vaultData.accounts.find((a) => a.id === meta.activeAccountId);
    if (!vaultAccount) throw new Error("No active account in vault");
    return algosdk.mnemonicToSecretKey(vaultAccount.mnemonic).sk;
  },

  /** Get secret key for a specific address (wallet must be unlocked) */
  async getSecretKeyForAddress(address: string): Promise<Uint8Array> {
    if (!_vaultData) throw new Error("Wallet is locked");
    const vaultAccount = _vaultData.accounts.find((a) => a.address === address);
    if (!vaultAccount) throw new Error(`Account ${address} not in vault`);
    return algosdk.mnemonicToSecretKey(vaultAccount.mnemonic).sk;
  },

  /** Export mnemonic for backup (wallet must be unlocked) */
  async exportMnemonic(id: string): Promise<string> {
    if (!_vaultData) throw new Error("Wallet is locked");
    const vaultAccount = _vaultData.accounts.find((a) => a.id === id);
    if (!vaultAccount) throw new Error("Account not found in vault");
    return vaultAccount.mnemonic;
  },

  // ── Connected sites (H2: stored in encrypted vault, not plaintext meta) ──────

  async addConnectedSite(origin: string, addresses: string[]): Promise<void> {
    if (!_vaultData) throw new Error("Wallet is locked — unlock before connecting to a site");
    if (!_vaultData.connectedSites) _vaultData.connectedSites = {};
    _vaultData.connectedSites[origin] = addresses;
    await persistVaultData();
  },

  async removeConnectedSite(origin: string): Promise<void> {
    if (!_vaultData) throw new Error("Wallet is locked");
    if (_vaultData.connectedSites) {
      delete _vaultData.connectedSites[origin];
      await persistVaultData();
    }
  },

  async getConnectedAddresses(origin: string): Promise<string[]> {
    // Prefer vault (encrypted, up-to-date); fall back to legacy meta when locked
    if (_vaultData?.connectedSites) {
      return _vaultData.connectedSites[origin] ?? [];
    }
    const meta = await loadMeta();
    return meta.connectedSites?.[origin] ?? [];
  },
};
