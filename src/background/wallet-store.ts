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

/** Hex encode/decode helpers for Falcon key storage. */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Odd-length hex string");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(b)) throw new Error(`Invalid hex at offset ${i}`);
    bytes[i / 2] = b;
  }
  return bytes;
}
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
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_META]: meta });
  } catch (err: unknown) {
    // L4: Surface quota errors with a user-readable message instead of a
    // raw Chrome internal error that would be swallowed silently.
    if (/quota/i.test(err instanceof Error ? err.message : String(err))) {
      throw new Error("AlgoVoi: storage quota exceeded — free up space in chrome://settings.");
    }
    throw err;
  }
}

async function loadEncryptedVault(): Promise<EncryptedVault | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY_VAULT);
  return (result[STORAGE_KEY_VAULT] as EncryptedVault | undefined) ?? null;
}

async function saveEncryptedVault(vault: EncryptedVault): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_VAULT]: vault });
  } catch (err: unknown) {
    // L4: Surface quota errors with a user-readable message.
    if (/quota/i.test(err instanceof Error ? err.message : String(err))) {
      throw new Error("AlgoVoi: storage quota exceeded — free up space in chrome://settings.");
    }
    throw err;
  }
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

    // Auto-cleanup expired time-limited accounts
    const now = Date.now();
    const expired = _vaultData.accounts.filter((a) => a.expiresAt && now > a.expiresAt);
    if (expired.length > 0) {
      const expiredIds = new Set(expired.map((a) => a.id));
      _vaultData.accounts = _vaultData.accounts.filter((a) => !expiredIds.has(a.id));
      await persistVaultData();
      // Also remove from WalletMeta
      const cleanMeta = await loadMeta();
      cleanMeta.accounts = cleanMeta.accounts.filter((a) => !expiredIds.has(a.id));
      // If active account was expired, switch to first remaining or null
      if (cleanMeta.activeAccountId && expiredIds.has(cleanMeta.activeAccountId)) {
        cleanMeta.activeAccountId = cleanMeta.accounts[0]?.id ?? null;
      }
      await saveMeta(cleanMeta);
      console.log(`[wallet] removed ${expired.length} expired time-limited account(s)`);
    }

    // H2: One-time migration — move connectedSites from plaintext meta into the vault.
    // If the vault already has connectedSites (new wallet or already migrated), skip.
    if (!_vaultData.connectedSites) {
      const meta = await loadMeta();
      _vaultData.connectedSites = meta.connectedSites ?? {};
      await persistVaultData(); // re-encrypt with migrated data
      // M6: Remove the plaintext copy so site↔address mapping is no longer
      // readable from chrome.storage.local after migration completes.
      if (meta.connectedSites) {
        delete meta.connectedSites;
        await saveMeta(meta);
      }
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
   * Import a mnemonic with a time-limited TTL. After `ttlDays` days,
   * getActiveSecretKey() refuses to return the key and the account is
   * auto-removed on the next unlock. Stored encrypted in the vault.
   */
  async importTimeLimitedAccount(
    name: string,
    mnemonic: string,
    ttlDays: number = 30
  ): Promise<Account> {
    if (!_vaultData) throw new Error("Wallet is locked");
    const trimmed = mnemonic.trim();
    const kp      = algosdk.mnemonicToSecretKey(trimmed); // throws on invalid
    const id      = randomId();
    const address = kp.addr.toString();

    // Check for duplicate address
    const meta = await loadMeta();
    const dup  = meta.accounts.find((a) => a.address === address);
    if (dup) {
      // Update existing vault account's expiry + mnemonic (refresh)
      const vaultAcct = _vaultData.accounts.find((a) => a.address === address);
      if (vaultAcct) {
        vaultAcct.mnemonic  = trimmed;
        vaultAcct.expiresAt = Date.now() + ttlDays * 86_400_000;
        await persistVaultData();
        return dup;
      }
    }

    const expiresAt = Date.now() + ttlDays * 86_400_000;
    _vaultData.accounts.push({ id, address, mnemonic: trimmed, expiresAt });
    await persistVaultData();
    const account: Account = { id, name, address, type: "mnemonic" };
    meta.accounts.push(account);
    meta.activeAccountId = id;
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
    const meta = await loadMeta();

    // Upsert: if an account with this address already exists as a WC account,
    // update its session topic rather than creating a duplicate. This is the
    // re-pair path — the user's Algorand address never changes, only the WC
    // session changes when the wallet app disconnects or is reinstalled.
    const existing = meta.accounts.find(
      (a) => a.address === address && a.type === "walletconnect"
    );
    if (existing) {
      existing.wcSessionTopic = sessionTopic;
      existing.wcPeerName     = peerName;
      if (chain) existing.wcChain = chain;
      await saveMeta(meta);
      return existing;
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
    // TTL check — refuse to sign with an expired time-limited key
    if (vaultAccount.expiresAt && Date.now() > vaultAccount.expiresAt) {
      throw new Error(
        "This account's 30-day local signing key has expired.\n" +
        "Re-import your mnemonic via + Add Account to refresh for another 30 days."
      );
    }
    return algosdk.mnemonicToSecretKey(vaultAccount.mnemonic).sk;
  },

  /** Get secret key for a specific address (wallet must be unlocked) */
  async getSecretKeyForAddress(address: string): Promise<Uint8Array> {
    if (!_vaultData) throw new Error("Wallet is locked");
    const vaultAccount = _vaultData.accounts.find((a) => a.address === address);
    if (!vaultAccount) throw new Error(`Account ${address} not in vault`);
    if (vaultAccount.expiresAt && Date.now() > vaultAccount.expiresAt) {
      throw new Error(
        "This account's 30-day local signing key has expired.\n" +
        "Re-import your mnemonic via + Add Account to refresh for another 30 days."
      );
    }
    return algosdk.mnemonicToSecretKey(vaultAccount.mnemonic).sk;
  },

  /** Get the expiry timestamp for a vault account (null = permanent) */
  getAccountExpiry(id: string): number | null {
    if (!_vaultData) return null;
    const acct = _vaultData.accounts.find((a) => a.id === id);
    return acct?.expiresAt ?? null;
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

  // ── SpendingCapVault agent key + app registry ─────────────────────────────
  // All vault data lives inside the AES-GCM encrypted vault — never plaintext.

  /** Generate (or replace) the agent keypair. Returns the new agent address. */
  async createAgentKey(): Promise<string> {
    if (!_vaultData) throw new Error("Wallet is locked");
    const mn      = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
    const address = algosdk.mnemonicToSecretKey(mn).addr.toString();
    _vaultData.agentKey = { mnemonic: mn, address };
    await persistVaultData();
    return address;
  },

  /** Returns the 64-byte agent secret key (wallet must be unlocked). */
  async getAgentSecretKey(): Promise<Uint8Array> {
    if (!_vaultData) throw new Error("Wallet is locked");
    if (!_vaultData.agentKey) throw new Error("No agent key — deploy vault first");
    return algosdk.mnemonicToSecretKey(_vaultData.agentKey.mnemonic).sk;
  },

  /** Returns the agent's public address (wallet must be unlocked). */
  getAgentAddress(): string | null {
    return _vaultData?.agentKey?.address ?? null;
  },

  /** Save a deployed app ID+address for a chain (persisted in encrypted vault). */
  async saveVaultApp(chain: string, appId: number, appAddress: string): Promise<void> {
    if (!_vaultData) throw new Error("Wallet is locked");
    if (!_vaultData.vaultApps) _vaultData.vaultApps = {};
    _vaultData.vaultApps[chain] = { appId, appAddress };
    await persistVaultData();
  },

  /** Returns the deployed app for a chain, or null if not yet deployed. */
  getVaultApp(chain: string): { appId: number; appAddress: string } | null {
    return _vaultData?.vaultApps?.[chain] ?? null;
  },

  // ── Falcon PQC accounts ──────────────────────────────────────────────────
  // Post-quantum Falcon-1024 accounts. Keys are raw bytes (not mnemonics).
  // Stored encrypted in the same AES-GCM vault as Ed25519 accounts.

  /** Create a new Falcon PQC account. Returns the Account metadata. */
  async createFalconAccount(name: string): Promise<Account> {
    if (!_vaultData) throw new Error("Wallet is locked");
    const { falconKeygen } = await import("@shared/utils/falcon-wasm");
    const { deriveFalconAddress } = await import("@shared/utils/falcon-teal");
    const { pk, sk } = await falconKeygen();
    const { program, address } = deriveFalconAddress(pk);
    const id = randomId();

    if (!_vaultData.falconAccounts) _vaultData.falconAccounts = [];
    _vaultData.falconAccounts.push({
      id,
      address,
      pk: toHex(pk),
      sk: toHex(sk),
      program: toHex(program),
    });
    await persistVaultData();

    const account: Account = { id, name, address, type: "falcon" };
    const meta = await loadMeta();
    meta.accounts.push(account);
    if (!meta.activeAccountId) meta.activeAccountId = id;
    await saveMeta(meta);
    return account;
  },

  /** Get Falcon vault data for signing (wallet must be unlocked). */
  getFalconVaultData(accountId: string): {
    pk: Uint8Array;
    sk: Uint8Array;
    program: Uint8Array;
    expiresAt?: number;
  } | null {
    if (!_vaultData?.falconAccounts) return null;
    const fa = _vaultData.falconAccounts.find((a) => a.id === accountId);
    if (!fa) return null;
    // Validate key sizes
    if (fa.pk.length !== 1793 * 2 || fa.sk.length !== 2305 * 2) {
      throw new Error("Falcon key size mismatch — vault may be corrupted");
    }
    return {
      pk: fromHex(fa.pk),
      sk: fromHex(fa.sk),
      program: fromHex(fa.program),
      expiresAt: fa.expiresAt,
    };
  },

  /** Export Falcon keys as hex strings (for backup). */
  exportFalconKeys(accountId: string): { pk: string; sk: string } | null {
    if (!_vaultData?.falconAccounts) return null;
    const fa = _vaultData.falconAccounts.find((a) => a.id === accountId);
    if (!fa) return null;
    return { pk: fa.pk, sk: fa.sk };
  },

  /** Store Claude API key in encrypted vault. */
  async setClaudeApiKey(apiKey: string): Promise<void> {
    if (!_vaultData) throw new Error("Wallet is locked");
    _vaultData.claudeApiKey = apiKey;
    await persistVaultData();
  },

  /** Returns the Claude API key (wallet must be unlocked). */
  getClaudeApiKey(): string | null {
    return _vaultData?.claudeApiKey ?? null;
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
