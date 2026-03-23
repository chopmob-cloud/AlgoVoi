/**
 * appendDebugLog — persistent bounded debug log for WalletConnect diagnostics.
 *
 * Stores up to MAX_ENTRIES entries in chrome.storage.local under "algovou_debug_log".
 * Safe to call from popup, background service worker, or approval page.
 *
 * NEVER logs private keys, mnemonics, tokens, seeds, or full WC URIs.
 * Topics and addresses are truncated before storage.
 *
 * Write queue: rapid back-to-back calls are serialized so no entries are lost
 * to the read-modify-write race condition in chrome.storage.local.
 */

export const DEBUG_LOG_KEY = "algovou_debug_log";
const MAX_ENTRIES = 100;
/** Auto-expire entries older than 7 days to limit forensic exposure */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DebugLogEntry {
  t: number;              // unix ms timestamp
  msg: string;            // short event label, e.g. "wc:race_winner"
  meta?: Record<string, unknown>;
}

/** Truncate a WalletConnect topic to first 8 chars + ellipsis. */
export function sanitizeTopic(topic: string | null | undefined): string | null {
  if (!topic) return null;
  return topic.length > 8 ? topic.slice(0, 8) + "\u2026" : topic;
}

/** Show first 6 + last 4 chars of an Algorand address. */
export function sanitizeAddress(addr: string | null | undefined): string | null {
  if (!addr) return null;
  return addr.length > 12 ? addr.slice(0, 6) + "\u2026" + addr.slice(-4) : addr;
}

// ── Write queue ────────────────────────────────────────────────────────────
// Multiple synchronous calls to appendDebugLog hit the same chrome.storage
// get→set cycle before the previous write completes, causing entries to be
// overwritten. The queue serializes writes within the same JS context so every
// entry is preserved.
const _pending: DebugLogEntry[] = [];
let _flushing = false;

function _flush(): void {
  if (_flushing || _pending.length === 0) return;
  _flushing = true;
  try {
    chrome.storage.local.get(DEBUG_LOG_KEY, (result) => {
      if (chrome.runtime.lastError) {
        _flushing = false;
        return;
      }
      const existing: DebugLogEntry[] = Array.isArray(result[DEBUG_LOG_KEY])
        ? (result[DEBUG_LOG_KEY] as DebugLogEntry[])
        : [];
      // Drain all entries accumulated while we were waiting for the get
      const toWrite = _pending.splice(0);
      const now = Date.now();
      // Auto-expire entries older than MAX_AGE_MS to limit forensic exposure
      const fresh = [...existing, ...toWrite].filter((e) => now - e.t < MAX_AGE_MS);
      const updated = fresh.slice(-MAX_ENTRIES);
      chrome.storage.local.set({ [DEBUG_LOG_KEY]: updated }, () => {
        _flushing = false;
        // If more entries arrived while we were writing, flush again
        if (_pending.length > 0) _flush();
      });
    });
  } catch {
    _flushing = false;
  }
}

/**
 * Append a debug log entry to chrome.storage.local.
 * Non-blocking; any storage error is silently ignored so it never breaks the app.
 * Serialized via write queue to prevent lost entries on rapid successive calls.
 */
export function appendDebugLog(msg: string, meta?: Record<string, unknown>): void {
  try {
    _pending.push({ t: Date.now(), msg, ...(meta ? { meta } : {}) });
    _flush();
  } catch {
    // Non-fatal — extension context may be invalidated (e.g. during reload).
  }
}

/** Remove all stored debug log entries. */
export function clearDebugLog(): void {
  try {
    chrome.storage.local.remove(DEBUG_LOG_KEY);
  } catch {
    // Non-fatal
  }
}

/**
 * Download the full debug log as a timestamped JSON file via browser download.
 * Only callable from a page context (popup / tab) — not from a service worker.
 *
 * Call with a short delay after appendDebugLog so the write queue has time to
 * drain before the storage read:
 *   appendDebugLog("some:event", { ... });
 *   setTimeout(exportDebugLog, 300);
 */
export function exportDebugLog(): void {
  try {
    chrome.storage.local.get(DEBUG_LOG_KEY, (result) => {
      if (chrome.runtime.lastError) return;
      const entries: DebugLogEntry[] = Array.isArray(result[DEBUG_LOG_KEY])
        ? (result[DEBUG_LOG_KEY] as DebugLogEntry[])
        : [];
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `algovou-debug-${ts}.json`;
      const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  } catch {
    // Non-fatal — will fail in service-worker context or invalidated extension context
  }
}
