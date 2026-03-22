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
 *     Copies keychain + session from localStorage into chrome.storage.local
 *     along with a `pairedAt` Unix timestamp (ms).
 *     chrome.storage.local survives lock/unlock cycles and browser restarts.
 *
 *   restoreWCStorage() — call before every SignClient.init().
 *     Checks the `pairedAt` timestamp. If the snapshot is older than
 *     WC_SESSION_MAX_AGE_MS (30 days) it is discarded and the caller will
 *     get a fresh "no session" state → re-pair is required.
 *     Otherwise copies the data back into localStorage so the SDK finds it.
 *     Safe to call unconditionally — no-op when no valid snapshot exists.
 *
 * Lifecycle:
 *   - Snapshot created on every successful pairing (replaces any previous).
 *   - Snapshot updated whenever addWCAccount upserts a new session topic.
 *   - After 30 days restoreWCStorage() refuses to restore and clears the
 *     snapshot, so the next signing attempt fails fast with a re-pair prompt.
 *   - Snapshot cleared when the last WC account is removed (clearWCStorage).
 *
 * Security note:
 *   wc@2:core:keychain contains WalletConnect relay symmetric keys — used only
 *   to encrypt relay transport messages. They are NOT Algorand signing keys and
 *   do NOT control funds. Storing them in chrome.storage.local is an acceptable
 *   trade-off (same threat surface as WalletMeta which is also plaintext).
 *   The Algorand mnemonic/private key remains exclusively in the AES-GCM vault.
 */

import { STORAGE_KEY_WC_SESSIONS } from "@shared/constants";
export { STORAGE_KEY_WC_SESSIONS };

/** The two WC SDK localStorage keys we persist. */
const WC_PERSIST_KEYS = [
  "wc@2:core:keychain",
  "wc@2:client:session",
] as const;

/** 30 days in milliseconds — maximum age of a stored WC session snapshot. */
const WC_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface WCSnapshot {
  /** WC SDK localStorage key → value pairs. */
  keys: Record<string, string>;
  /** Unix timestamp (ms) when this snapshot was created by pairing. */
  pairedAt: number;
}

/**
 * Snapshot live WC session data from localStorage into chrome.storage.local.
 * Call this after a successful WalletConnect pairing so the data survives
 * the next lock/unlock cycle.
 *
 * Includes a `pairedAt` timestamp so restoreWCStorage() can enforce the
 * 30-day maximum session age and force fresh pairing when it expires.
 */
export async function snapshotWCStorage(): Promise<void> {
  const keys: Record<string, string> = {};
  for (const key of WC_PERSIST_KEYS) {
    const val = localStorage.getItem(key);
    if (val) keys[key] = val;
  }
  if (Object.keys(keys).length === 0) return; // nothing to save

  const snapshot: WCSnapshot = { keys, pairedAt: Date.now() };
  await chrome.storage.local.set({ [STORAGE_KEY_WC_SESSIONS]: snapshot });
  console.log("[wc-storage] snapshot saved, pairedAt:", new Date(snapshot.pairedAt).toISOString());
}

/**
 * Restore WC session data from chrome.storage.local back into localStorage.
 * Call this before every SignClient.init() so the SDK can find existing sessions
 * that were wiped from localStorage by a lock event.
 *
 * Returns true if data was restored, false if snapshot was missing or expired.
 * A false return means the caller should treat this as a "no session" state
 * and show a re-pair prompt rather than waiting for a signing timeout.
 */
export async function restoreWCStorage(): Promise<boolean> {
  const result = await chrome.storage.local.get(STORAGE_KEY_WC_SESSIONS);
  const snapshot = result[STORAGE_KEY_WC_SESSIONS] as WCSnapshot | Record<string, string> | undefined;
  if (!snapshot) return false;

  // Support old format (plain Record without pairedAt) — treat as expired.
  const typed = snapshot as WCSnapshot;
  if (!typed.pairedAt || !typed.keys) {
    console.warn("[wc-storage] old snapshot format — clearing, re-pair required");
    await chrome.storage.local.remove(STORAGE_KEY_WC_SESSIONS);
    return false;
  }

  // Enforce 30-day maximum session age.
  const ageMs = Date.now() - typed.pairedAt;
  if (ageMs > WC_SESSION_MAX_AGE_MS) {
    console.warn("[wc-storage] snapshot expired after 30 days — clearing, re-pair required");
    await chrome.storage.local.remove(STORAGE_KEY_WC_SESSIONS);
    return false;
  }

  // Restore valid snapshot into localStorage.
  for (const [key, val] of Object.entries(typed.keys)) {
    if (WC_PERSIST_KEYS.includes(key as typeof WC_PERSIST_KEYS[number]) && typeof val === "string") {
      localStorage.setItem(key, val);
    }
  }

  const daysOld = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
  console.log(`[wc-storage] restored (${daysOld}d old, expires in ${(30 - parseFloat(daysOld)).toFixed(1)}d)`);
  return true;
}

/**
 * Returns the age of the current snapshot in milliseconds, or null if no
 * snapshot exists. Callers can use this to warn users before expiry.
 */
export async function wcSnapshotAgeMs(): Promise<number | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY_WC_SESSIONS);
  const snapshot = result[STORAGE_KEY_WC_SESSIONS] as WCSnapshot | undefined;
  if (!snapshot?.pairedAt) return null;
  return Date.now() - snapshot.pairedAt;
}

/**
 * Clear the WC session snapshot from chrome.storage.local.
 * Call when the last WalletConnect account is removed so the stale
 * snapshot does not resurrect a dead session on the next pairing.
 */
export async function clearWCStorage(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY_WC_SESSIONS);
  console.log("[wc-storage] snapshot cleared");
}
