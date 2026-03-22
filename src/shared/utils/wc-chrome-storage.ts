/**
 * WalletConnect KeyValueStorage adapter backed by chrome.storage.local.
 *
 * Replaces the WC SDK's default localStorage adapter which fails in MV3:
 *   - Background service workers have no localStorage
 *   - Extension popups lose localStorage on lock (L5* security wipe)
 *   - Per-use SignClient instances recreate localStorage state each time
 *
 * With this adapter:
 *   - Session data survives lock/unlock cycles, SW suspension, and browser restarts
 *   - No snapshot/restore mechanism needed (the SDK reads/writes directly)
 *   - All WC SDK storage is namespaced under a prefix to avoid collisions
 *
 * The IKeyValueStorage interface is fully async, so chrome.storage.local
 * (which is also async) is a natural fit.
 */

const PREFIX = "wc_kv:";

function prefixKey(key: string): string {
  return PREFIX + key;
}

function unprefixKey(key: string): string {
  return key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;
}

/**
 * Read all WC-prefixed keys from chrome.storage.local.
 * Returns a record of unprefixed key → value.
 */
async function readAll(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (items) => {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(items)) {
        if (k.startsWith(PREFIX)) {
          result[unprefixKey(k)] = v;
        }
      }
      resolve(result);
    });
  });
}

/**
 * IKeyValueStorage implementation using chrome.storage.local.
 *
 * Passed to SignClient.init({ storage: chromeStorage }) and
 * Core({ storage: chromeStorage }) so the WC SDK persists all
 * session, keychain, and subscription data in extension storage.
 */
/**
 * One-time migration: copy WC session data from the old storage locations
 * (localStorage wc@2:* keys and/or the algovou_wc_sessions snapshot) into
 * the new chromeStorage format (wc_kv: prefix). Runs automatically on first
 * use — existing sessions work without re-pairing.
 */
let _migrated = false;
async function migrateOldStorage(): Promise<void> {
  if (_migrated) return;
  _migrated = true;

  const toWrite: Record<string, unknown> = {};

  // Source 1: old snapshot in chrome.storage.local (algovou_wc_sessions)
  const result = await new Promise<Record<string, unknown>>((resolve) =>
    chrome.storage.local.get("algovou_wc_sessions", resolve)
  );
  const snapshot = result["algovou_wc_sessions"] as
    | { keys?: Record<string, string>; pairedAt?: number }
    | Record<string, string>
    | undefined;
  if (snapshot) {
    // New format: { keys: {...}, pairedAt }
    const entries = (snapshot as { keys?: Record<string, string> }).keys ?? snapshot;
    for (const [k, v] of Object.entries(entries)) {
      if (typeof k === "string" && k.startsWith("wc@2:") && typeof v === "string") {
        try { toWrite[prefixKey(k)] = JSON.parse(v); } catch { toWrite[prefixKey(k)] = v; }
      }
    }
  }

  // Source 2: localStorage (if available — popup context only)
  if (typeof localStorage !== "undefined") {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("wc@2:")) {
        const v = localStorage.getItem(k);
        if (v && !(prefixKey(k) in toWrite)) {
          try { toWrite[prefixKey(k)] = JSON.parse(v); } catch { toWrite[prefixKey(k)] = v; }
        }
      }
    }
  }

  if (Object.keys(toWrite).length === 0) return;

  // Check if new storage already has data (don't overwrite a fresh pairing)
  const existing = await readAll();
  if (Object.keys(existing).length > 0) return; // already migrated or fresh pairing exists

  await new Promise<void>((resolve) => chrome.storage.local.set(toWrite, resolve));
  console.log(`[wc-chrome-storage] migrated ${Object.keys(toWrite).length} keys from old storage`);
}

export const chromeStorage = {
  async getKeys(): Promise<string[]> {
    await migrateOldStorage();
    const all = await readAll();
    return Object.keys(all);
  },

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    await migrateOldStorage();
    const all = await readAll();
    return Object.entries(all) as [string, T][];
  },

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    await migrateOldStorage();
    return new Promise((resolve) => {
      chrome.storage.local.get(prefixKey(key), (result) => {
        resolve(result[prefixKey(key)] as T | undefined);
      });
    });
  },

  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [prefixKey(key)]: value }, () => {
        resolve();
      });
    });
  },

  async removeItem(key: string): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.local.remove(prefixKey(key), () => {
        resolve();
      });
    });
  },
};
