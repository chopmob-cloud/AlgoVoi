/**
 * Anti-phishing utilities for AlgoVoi.
 *
 * Defences:
 *   1. Clipboard hijacking detection — compare pasted address against clipboard
 *   2. Homograph domain detection — flag mixed-script Unicode in origins
 *   3. Scam address check — query known blocklists before sending
 */

// ── Clipboard hijacking detection ────────────────────────────────────────────

/**
 * Check if a pasted value matches what's currently in the clipboard.
 * Malware can replace clipboard content between copy and paste.
 * Returns a warning string if mismatch detected, null if OK.
 */
export async function checkClipboardHijack(
  pastedValue: string
): Promise<string | null> {
  try {
    const clipboardText = await navigator.clipboard.readText();
    const trimmedPaste = pastedValue.trim();
    const trimmedClip  = clipboardText.trim();
    if (trimmedPaste && trimmedClip && trimmedPaste !== trimmedClip) {
      return (
        "Warning: the pasted address differs from your clipboard content. " +
        "This may indicate clipboard hijacking malware. " +
        "Please verify the address carefully before sending."
      );
    }
  } catch {
    // Clipboard API not available or permission denied — can't check
  }
  return null;
}

// ── Homograph domain detection ───────────────────────────────────────────────

/**
 * Detect mixed-script Unicode in a hostname (homograph attack).
 * Returns a warning if the hostname contains non-ASCII characters that
 * could visually mimic Latin characters (Cyrillic а, Greek ο, etc.)
 */
export function checkHomographDomain(hostname: string): string | null {
  // Skip IP addresses and localhost
  if (/^(\d+\.){3}\d+$/.test(hostname) || hostname === "localhost") return null;

  // Check for non-ASCII characters (IDN / Unicode)
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(hostname)) {
    // Convert to punycode representation for display
    let punycode = hostname;
    try {
      punycode = new URL(`https://${hostname}`).hostname;
    } catch { /* keep original */ }

    return (
      `Warning: this site uses non-standard characters in its domain name ` +
      `(${punycode}). This may be a phishing site impersonating a legitimate domain. ` +
      `Verify the URL carefully before approving any transactions.`
    );
  }

  return null;
}

// ── Known confusable characters ──────────────────────────────────────────────

/** Common Unicode characters that look like Latin letters */
const CONFUSABLES: Record<string, string> = {
  "\u0430": "a", // Cyrillic а
  "\u0435": "e", // Cyrillic е
  "\u043E": "o", // Cyrillic о
  "\u0440": "p", // Cyrillic р
  "\u0441": "c", // Cyrillic с
  "\u0443": "y", // Cyrillic у
  "\u0445": "x", // Cyrillic х
  "\u0456": "i", // Ukrainian і
  "\u04BB": "h", // Cyrillic һ
  "\u0261": "g", // Latin small script g
  "\u03BF": "o", // Greek omicron
  "\u03B1": "a", // Greek alpha
};

/**
 * Check if a hostname contains known confusable characters.
 * More specific than the general non-ASCII check above.
 */
export function findConfusableChars(hostname: string): string[] {
  const found: string[] = [];
  for (const char of hostname) {
    if (CONFUSABLES[char]) {
      found.push(`'${char}' looks like '${CONFUSABLES[char]}'`);
    }
  }
  return found;
}
