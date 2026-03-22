/**
 * WC session persistence helpers.
 *
 * Problem:
 *   The WC SDK stores session data in extension localStorage under keys
 *   prefixed "wc@2:". The two critical keys are:
 *     - wc@2:core:keychain   — symmetric relay encryption keys per topic
 *     - wc@2:client:session  — session metadata (topic, expiry, peer, namespaces)
 *
 *   Without both keys, SignClient.init() starts blind — it can't find an
 *   existing session and the wcSessionTopic stored in WalletMeta is useless.
 *
 *   Two things wipe these keys:
 *     1. The lock handler in App.tsx deletes all "wc@2:*" on wallet lock
 *        (security hardening L5*). Default auto-lock is 5 minutes, so a
 *        normal work session wipes WC data constantly.
 *     2. MV3 service worker suspension triggers a lock, which triggers #1.
 *
 * Solution:
 *   snapshotWCStorage() — call after pairing succeeds.
 *     Copies keychain + session from localStorage into chrome.storage.local.
 *     chrome.storage.local survives lock/unlock cycles and browser restarts.
 *
 *   restoreWCStorage() — call before every SignClient.init().
 *     Copies the snapshot back into localStorage so the init finds the session.
 *     No-op when no snapshot exists (first launch, or all WC accounts removed).
 *
 * Security note:
 *   wc@2:core:keychain contains WalletConnect relay symmetric keys — used only
 *   to encrypt relay transport messages. They are NOT Algorand signing keys and
 *   do NOT control funds. Storing them unencrypted in chrome.storage.local is
 *   an acceptable trade-off (same threat surface as the WalletMeta which is
 *   also plaintext). The Algorand mnemonic/private key remains exclusively in
 *   the AES-GCM encrypted vault.
 */

import { STORAGE_KEY_WC_SESSIONS } from "@shared/constants";
export { STORAGE_KEY_WC_SESSIONS };

/** The two WC SDK localStorage keys we persist. */
const WC_PERSIST_KEYS = [
  "wc@2:core:keychain",
  "wc@2:client:session",
] as const;

/**
 * Snapshot live WC session data from localStorage into chrome.storage.local.
 * Call this after a successful WalletConnect pairing so the data survives
 * the next lock/unlock cycle.
 *
 * Only the keychain and session keys are saved — pairing/proposal/subscription
 * keys are transient and regenerated automatically on the next startPairing().
 */
export async function snapshotWCStorage(): Promise<void> {
  const snapshot: Record<string, string> = {};
  for (const key of WC_PERSIST_KEYS) {
    const val = localStorage.getItem(key);
    if (val) snapshot[key] = val;
  }
  if (Object.keys(snapshot).length === 0) return; // nothing to save
  await chrome.storage.local.set({ [STORAGE_KEY_WC_SESSIONS]: snapshot });
}

/**
 * Restore WC session data from chrome.storage.local back into localStorage.
 * Call this before every SignClient.init() so the SDK can find existing sessions
 * that were wiped from localStorage by a lock event.
 *
 * Safe to call unconditionally — no-op if no snapshot exists.
 */
export async function restoreWCStorage(): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY_WC_SESSIONS);
  const snapshot = result[STORAGE_KEY_WC_SESSIONS] as Record<string, string> | undefined;
  if (!snapshot) return;
  for (const [key, val] of Object.entries(snapshot)) {
    if (WC_PERSIST_KEYS.includes(key as typeof WC_PERSIST_KEYS[number]) && typeof val === "string") {
      localStorage.setItem(key, val);
    }
  }
}

/**
 * Clear the WC session snapshot from chrome.storage.local.
 * Call when the last WalletConnect account is removed so the stale
 * snapshot does not resurrect a dead session on the next pairing.
 */
export async function clearWCStorage(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY_WC_SESSIONS);
}
