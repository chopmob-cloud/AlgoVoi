/**
 * Falcon-1024 WASM wrapper — Algorand-compatible deterministic signatures.
 *
 * Lazy-loads the Emscripten WASM module on first use. The module is 88KB
 * (compiled from github.com/algorand/falcon — same C code as AVM falcon_verify).
 *
 * Key sizes: PK 1793 bytes, SK 2305 bytes, sig ≤1423 bytes (compressed).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _module: any = null;

// SHA-256 hashes of the bundled Falcon binaries (integrity verification)
const EXPECTED_WASM_HASH = "311d79abcfca3898cce53c3b120dfe1acde0dc180716ff48dfdf159ba09650f8";
const EXPECTED_JS_HASH   = "76beab0d96a735d4aef3a3e1ed40f3a7b3995bd15c88c841648409c68d0ac932";

/** Compute SHA-256 hex hash of an ArrayBuffer. */
async function sha256hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Load the Falcon WASM module (lazy, cached, integrity-verified). */
async function getModule() {
  if (_module) return _module;

  const glueUrl = chrome.runtime.getURL("falcon/falcon.js");
  const wasmUrl = chrome.runtime.getURL("falcon/falcon.wasm");

  // Fetch both binaries
  const [wasmResponse, glueResponse] = await Promise.all([fetch(wasmUrl), fetch(glueUrl)]);
  const wasmBinary = await wasmResponse.arrayBuffer();
  const glueCode = await glueResponse.text();

  // Integrity verification — reject tampered binaries
  const wasmHash = await sha256hex(wasmBinary);
  if (wasmHash !== EXPECTED_WASM_HASH) {
    throw new Error("Falcon WASM binary integrity check failed");
  }
  const jsHash = await sha256hex(new TextEncoder().encode(glueCode).buffer);
  if (jsHash !== EXPECTED_JS_HASH) {
    throw new Error("Falcon JS glue integrity check failed");
  }

  // Execute the Emscripten glue to get the factory function
  // eslint-disable-next-line no-new-func
  const factory = new Function("module", "exports", glueCode + "\nreturn module.exports;");
  const m = { exports: {} as Record<string, unknown> };
  const FalconModule = factory(m, m.exports);

  _module = await FalconModule({ wasmBinary });
  return _module;
}

export const FALCON_PK_SIZE = 1793;
export const FALCON_SK_SIZE = 2305;

/**
 * Generate a Falcon-1024 keypair from a 48-byte seed (deterministic).
 * If no seed provided, generates random 48-byte seed.
 */
export async function falconKeygen(seed?: Uint8Array): Promise<{
  pk: Uint8Array;
  sk: Uint8Array;
  seed: Uint8Array;
}> {
  const mod = await getModule();
  const actualSeed = seed ?? crypto.getRandomValues(new Uint8Array(48));

  const seedPtr = mod._malloc(48);
  const pkPtr = mod._malloc(FALCON_PK_SIZE);
  const skPtr = mod._malloc(FALCON_SK_SIZE);

  try {
    mod.HEAPU8.set(actualSeed, seedPtr);
    const rc: number = mod.ccall(
      "falcon_wasm_keygen", "number",
      ["number", "number", "number"],
      [seedPtr, pkPtr, skPtr],
    );
    if (rc !== 0) throw new Error(`Falcon keygen failed (rc=${rc})`);

    return {
      pk: new Uint8Array(mod.HEAPU8.buffer, pkPtr, FALCON_PK_SIZE).slice(),
      sk: new Uint8Array(mod.HEAPU8.buffer, skPtr, FALCON_SK_SIZE).slice(),
      seed: actualSeed,
    };
  } finally {
    // Wipe seed and SK from WASM memory
    mod.HEAPU8.fill(0, seedPtr, seedPtr + 48);
    mod.HEAPU8.fill(0, skPtr, skPtr + FALCON_SK_SIZE);
    mod._free(seedPtr);
    mod._free(pkPtr);
    mod._free(skPtr);
  }
}

/**
 * Sign a message with Falcon-1024 (deterministic compressed signature).
 * Returns the variable-length compressed signature.
 */
export async function falconSign(sk: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const mod = await getModule();
  const sigMax: number = mod.ccall("falcon_wasm_sig_maxsize", "number", [], []);

  const skPtr = mod._malloc(FALCON_SK_SIZE);
  const msgPtr = mod._malloc(msg.length);
  const sigPtr = mod._malloc(sigMax);
  const sigLenPtr = mod._malloc(4);

  try {
    mod.HEAPU8.set(sk, skPtr);
    mod.HEAPU8.set(msg, msgPtr);

    const rc: number = mod.ccall(
      "falcon_wasm_sign", "number",
      ["number", "number", "number", "number", "number"],
      [skPtr, msgPtr, msg.length, sigPtr, sigLenPtr],
    );
    if (rc !== 0) throw new Error(`Falcon sign failed (rc=${rc})`);

    const sigLen: number = mod.getValue(sigLenPtr, "i32");
    return new Uint8Array(mod.HEAPU8.buffer, sigPtr, sigLen).slice();
  } finally {
    mod.HEAPU8.fill(0, skPtr, skPtr + FALCON_SK_SIZE);
    mod._free(skPtr);
    mod._free(msgPtr);
    mod._free(sigPtr);
    mod._free(sigLenPtr);
  }
}

/**
 * Verify a Falcon-1024 compressed signature.
 * Returns true if the signature is valid.
 */
export async function falconVerify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
  const mod = await getModule();

  const pkPtr = mod._malloc(FALCON_PK_SIZE);
  const msgPtr = mod._malloc(msg.length);
  const sigPtr = mod._malloc(sig.length);

  try {
    mod.HEAPU8.set(pk, pkPtr);
    mod.HEAPU8.set(msg, msgPtr);
    mod.HEAPU8.set(sig, sigPtr);

    const rc: number = mod.ccall(
      "falcon_wasm_verify", "number",
      ["number", "number", "number", "number", "number"],
      [pkPtr, msgPtr, msg.length, sigPtr, sig.length],
    );
    return rc === 0;
  } finally {
    mod._free(pkPtr);
    mod._free(msgPtr);
    mod._free(sigPtr);
  }
}
