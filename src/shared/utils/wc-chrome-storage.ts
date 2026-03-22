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
export const chromeStorage = {
  async getKeys(): Promise<string[]> {
    const all = await readAll();
    return Object.keys(all);
  },

  async getEntries<T = unknown>(): Promise<[string, T][]> {
    const all = await readAll();
    return Object.entries(all) as [string, T][];
  },

  async getItem<T = unknown>(key: string): Promise<T | undefined> {
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
