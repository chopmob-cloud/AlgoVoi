/**
 * AES-GCM wallet encryption / decryption using Web Crypto API.
 * PBKDF2 key derivation with 600k iterations (OWASP 2023 recommendation).
 *
 * Session-key pattern:
 *   On unlock, derive the CryptoKey once and hold it in memory.
 *   All subsequent vault mutations re-encrypt with the same key + fresh IV,
 *   so the password is never stored and PBKDF2 runs only on unlock.
 */

import { PBKDF2_ITERATIONS } from "../constants";

// ── Hex helpers (exported so wallet-store can use them) ───────────────────────

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Key derivation ────────────────────────────────────────────────────────────

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Derive a CryptoKey from a password + freshly-generated random salt.
 * Used during wallet initialisation.
 */
export async function deriveNewKey(
  password: string
): Promise<{ key: CryptoKey; salt: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const key = await deriveKey(password, salt);
  return { key, salt };
}

/**
 * Derive a CryptoKey from a password + the salt stored in an existing vault.
 * Used during unlock — runs PBKDF2 once, result held in memory.
 */
export async function deriveKeyFromVault(
  password: string,
  saltHex: string
): Promise<CryptoKey> {
  return deriveKey(password, hexToBytes(saltHex));
}

// ── Encryption ────────────────────────────────────────────────────────────────

export interface EncryptedVault {
  salt: string;  // hex-encoded 32 bytes — fixed for the life of the vault
  iv: string;    // hex-encoded 12 bytes — fresh per encrypt call
  ciphertext: string;
}

/** Initial encrypt: generates salt + key + IV. Used during wallet init. */
export async function encryptVault(
  plaintext: string,
  password: string
): Promise<{ vault: EncryptedVault; key: CryptoKey; salt: Uint8Array }> {
  const { key, salt } = await deriveNewKey(password);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    vault: {
      salt: bytesToHex(salt),
      iv: bytesToHex(iv),
      ciphertext: bytesToHex(new Uint8Array(ciphertextBuf)),
    },
    key,
    salt,
  };
}

/**
 * Re-encrypt using an already-derived session CryptoKey (no PBKDF2 cost).
 * The salt is preserved; only a fresh IV is generated.
 * Used by _persistVaultData() for all post-init vault mutations.
 */
export async function reEncryptVault(
  plaintext: string,
  key: CryptoKey,
  saltHex: string
): Promise<EncryptedVault> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return {
    salt: saltHex,
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(ciphertextBuf)),
  };
}

// ── Decryption ────────────────────────────────────────────────────────────────

/** Decrypt vault data using an already-derived CryptoKey (no PBKDF2 cost). */
export async function decryptVaultWithKey(
  vault: EncryptedVault,
  key: CryptoKey
): Promise<string> {
  const iv = hexToBytes(vault.iv);
  const ciphertext = hexToBytes(vault.ciphertext);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  } catch {
    throw new Error("Decryption failed — wrong password?");
  }
  return new TextDecoder().decode(plaintext);
}

/** Convenience: derive key from password then decrypt. Used only for unlock. */
export async function decryptVault(
  vault: EncryptedVault,
  password: string
): Promise<{ plaintext: string; key: CryptoKey }> {
  const key = await deriveKeyFromVault(password, vault.salt);
  const plaintext = await decryptVaultWithKey(vault, key);
  return { plaintext, key };
}

// ── Misc ──────────────────────────────────────────────────────────────────────

/** Generate a random UUID v4 */
export function randomId(): string {
  return crypto.randomUUID();
}

// ── Base64 helpers ─────────────────────────────────────────────────────────────

/**
 * Decode any base64 string to Uint8Array — handles:
 *  - Standard base64      (A-Z a-z 0-9 + / =)
 *  - URL-safe base64      (- instead of +, _ instead of /)
 *  - Unpadded base64      (missing trailing = signs)
 *  - Line-wrapped base64  (newlines every 76 chars, e.g. Pera WC responses)
 *
 * Wallets such as Defly return URL-safe base64 from algo_signTxn; Pera returns
 * PEM-style line-wrapped base64. Chrome's native atob() rejects both; normalise
 * all variants before calling atob().
 */
export function base64ToBytes(b64: string): Uint8Array {
  // Strip whitespace (incl. PEM newlines) BEFORE padding so the length
  // calculation is correct — Pera wraps at 76 chars with \n which, if left in,
  // causes padding to be computed against the wrong length, and the over-padded
  // string is then rejected by native atob().
  const std = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Decode the base64 string returned by algo_signTxn (ARC-0025 / WalletConnect).
 *
 * Handles both response shapes wallets may return:
 *  - Flat array:   [signedB64, ...]           ← Pera / spec-compliant
 *  - Nested array: [[signedB64, ...], ...]    ← some Defly versions
 *
 * Returns the first signed transaction as a Uint8Array.
 * Throws if the wallet rejected (null / missing entry).
 */
/** Returns true iff every element of arr is an integer in [0, 255]. */
function isValidByteArray(arr: unknown[]): arr is number[] {
  return arr.every(
    (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255
  );
}

export function extractWCSignedTxn(result: unknown): Uint8Array {
  // Case 1: raw Uint8Array — unlikely over JSON-RPC but safe to passthrough
  if (result instanceof Uint8Array) return result;

  if (!Array.isArray(result) || result.length === 0) {
    throw new Error("Wallet rejected the transaction");
  }

  const first = result[0];

  // Case 2: [signedB64] — ARC-0025 spec compliant (Pera)
  if (typeof first === "string") {
    if (!first) throw new Error("Wallet rejected the transaction");
    return base64ToBytes(first);
  }

  // Case 3: [byte0, byte1, ...] — Defly: flat array of raw msgpack byte values
  if (typeof first === "number") {
    if (!isValidByteArray(result)) {
      throw new Error("Invalid WalletConnect response: malformed byte array");
    }
    return Uint8Array.from(result);
  }

  if (Array.isArray(first) && first.length > 0) {
    const inner = first[0];

    // Case 4: [[signedB64]] — nested base64 string
    if (typeof inner === "string") {
      if (!inner) throw new Error("Wallet rejected the transaction");
      return base64ToBytes(inner);
    }

    // Case 5: [[byte0, byte1, ...]] — Defly: nested array of raw msgpack byte values
    if (typeof inner === "number") {
      if (!isValidByteArray(first)) {
        throw new Error("Invalid WalletConnect response: malformed byte array");
      }
      return Uint8Array.from(first);
    }
  }

  throw new Error("Wallet rejected the transaction");
}
