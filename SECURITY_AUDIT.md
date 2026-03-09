# AlgoVoi Chrome Extension (MV3) — Security Audit Report

**Date:** March 2026
**Scope:** Comprehensive review of all `src/` files, `manifest.json`, and build configuration

## Final Status: All Critical/High/Medium Issues Resolved

```
0 Critical   0 High   0 Medium   0 Low open
```

All critical, high, medium, and low severity issues are closed.

**Hardening VII (March 2026):** Final adversarial review revealed one new Medium finding
(M6-CSP) — extension-page `connect-src` was absent, meaning the CSP did not explicitly
restrict which origins popup/approval pages may connect to. Fixed in the same pass; closed
before release. L1, L3, L4 previously open are now also confirmed closed (applied in
Hardening VI). L5\* WC localStorage clearing applied in Hardening VI.

**Hardening VIII (March 2026):** Post-release adversarial review and full re-audit.
Three new findings found and fixed in the same pass (L7–L9 below). All closed.

---

## Issue Register

| ID   | Severity | Status | Fix Applied |
|------|----------|--------|-------------|
| L7   | Low      | ✅ CLOSED | Note field byte truncation — encode-then-slice to 1000 bytes |
| L8   | Low      | ✅ CLOSED | WalletConnect `frame-src` CSP missing for `verify.walletconnect.org` |
| L9   | Low      | ✅ CLOSED | algosdk v3 `result.txId` → `result.txid` (WC payment proof was missing txId) |
| C1   | Critical | ✅ CLOSED | genesisID check before ARC27_SIGN_TXNS signing |
| C2   | Critical | ✅ CLOSED | Unlock rate-limit moved to `chrome.storage.session` |
| C3   | Critical | ✅ CLOSED | Vault persistence already correct; confirmed |
| H1   | High     | ✅ CLOSED | Genesis hash verified on `WALLET_SET_CHAIN` |
| H2   | High     | ✅ CLOSED | `connectedSites` encrypted in vault; migration on unlock |
| H3   | High     | ✅ CLOSED | Per-origin x402 queue capped at 5 pending requests |
| M1   | Medium   | ✅ CLOSED | uint64 overflow check in `parseDecimalToAtomic` |
| M2   | Medium   | ✅ CLOSED | Duplicate tx errors swallowed; real failures propagate |
| M3   | Medium   | ✅ CLOSED | Cookie stripped on x402 retry; Authorization preserved |
| M4   | Medium   | ✅ CLOSED | Dead-code `secureCompare()` with timing leak — removed |
| M5   | Medium   | ✅ CLOSED | Spending caps read from `meta.spendingCaps` with defaults |
| M6   | Medium   | ✅ CLOSED | CSP `connect-src` added; `default-src 'none'` baseline set |
| L1   | Low      | ✅ CLOSED | HTTPS origin guard added to `routeToBackground()` |
| L2   | Low      | ✅ CLOSED | Extension pages not frameable by design; confirmed |
| L3   | Low      | ✅ CLOSED | `frame-ancestors 'none'` meta tag in approval/index.html |
| L4   | Low      | ✅ CLOSED | Storage quota errors caught and re-thrown with readable message |
| L5   | Low      | ✅ CLOSED | `CHAIN_SUBMIT_SIGNED` now requires unlocked wallet |
| L5\* | Low      | ✅ CLOSED | WC session localStorage cleared on lock (popup `LOCK_STATE_CHANGED`) |
| L6   | Low      | ✅ CLOSED | CSP already correct for MV3; confirmed (superseded by M6) |

> **L5\* note:** `CHAIN_SUBMIT_SIGNED` now requires unlock, closing the concrete attack path.
> Clearing WC SDK localStorage on lock remains as optional defence-in-depth.

---

## Fix Details

### C1 — ARC27_SIGN_TXNS genesisID Validation
**File:** `src/background/message-handler.ts`
Check: `txn.genesisID !== CHAINS[activeChain].genesisId` before calling `signTxn()`.
Empty `genesisID` (`""`) skips the check safely; algosdk v3 cast is correct.

### C2 — Unlock Rate-Limit Persistence
**File:** `src/background/message-handler.ts`
`checkUnlockRate` / `clearUnlockRate` now use `chrome.storage.session` (async).
Survives service-worker suspension; keyed by `sender.url` origin (unforgeable).

### H1 — Chain Switch Genesis Hash Verification
**File:** `src/background/message-handler.ts`
Fetches `SuggestedParams` on switch; encodes `genesisHash` `Uint8Array` to base64;
compares against hardcoded `CHAINS[chain].genesisHash`. Mismatch throws; node
unreachable logs a warning but does not block (correct offline behaviour).

### H2 — connectedSites Moved to Encrypted Vault
**Files:** `src/shared/types/wallet.ts`, `src/background/wallet-store.ts`
`VaultData.connectedSites` added. `initialize()` writes `{}` into vault from day one.
`unlock()` migrates legacy `meta.connectedSites` on first unlock (one-time only).
`addConnectedSite` / `removeConnectedSite` now operate on `_vaultData` exclusively.
`getConnectedAddresses` falls back to legacy meta when locked (read-only).
`WalletMeta.connectedSites` marked `@deprecated` and made optional.

### H3 — Per-Origin x402 Queue Cap
**File:** `src/background/x402-handler.ts`
`handleX402()` counts pending requests from the same origin before queuing.
Throws at `>= 5` pending. Malformed URLs handled with `try/catch`.

### M1 — uint64 Upper-Bound
**File:** `src/background/message-handler.ts`
`parseDecimalToAtomic()` rejects values `> 18_446_744_073_709_551_615n`.

### M2 — Broadcast Error Handling
**File:** `src/background/x402-handler.ts`
`buildAndSignPayment()` wraps `submitTransaction` in `try/catch`. Errors containing
`"already"`, `"duplicate"`, `"already in ledger"`, `"txn already exists"` are swallowed
(expected for retried x402 payments); all other errors are re-thrown.

### M3 — Credential Handling on x402 Retry
**File:** `src/inpage/index.ts`
`Cookie` deleted from retry headers. `Authorization` preserved with `console.warn`
noting the forwarding so developers can audit their endpoint.

### M4 — Dead-Code secureCompare() Removed
**File:** `src/shared/utils/crypto.ts`
The function was never called anywhere in the codebase. It contained an
early-return timing leak (`if sig.length !== sig2.length return false`) before
the constant-time XOR loop. Removed entirely to eliminate the dead code and
the theoretical timing channel. The actual unlock path uses AES-GCM decryption
failure for password verification, which is internally constant-time.

### M5 — Configurable Spending Caps
**File:** `src/background/x402-handler.ts`
`buildPaymentTransaction()` reads `meta.spendingCaps?.{nativeMicrounits,asaMicrounits}`.
`undefined`-check (not falsy) allows a user to set a `0` cap to block all auto-payments.
Falls back to `SPENDING_CAP_NATIVE` / `SPENDING_CAP_ASA` (10,000,000 = 10 tokens).

### L5 (concrete path) — CHAIN_SUBMIT_SIGNED Lock Check
**File:** `src/background/message-handler.ts`
Added `if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked")`
and `walletStore.resetAutoLock()` to the `CHAIN_SUBMIT_SIGNED` handler.
Closes the narrow physical-access window where a WC session could be used to
broadcast a pre-signed transaction after auto-lock.

### L6 / M6 — Content Security Policy (Hardening VII)
**File:** `manifest.json`
Original: `"script-src 'self'; object-src 'none';"` — blocked `eval` and inline scripts.
Hardening VII extended to full lockdown:
```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src <all host_permission domains + wss:// variants>;
object-src 'none';
frame-ancestors 'none';
```
`connect-src` explicitly whitelists only the four algod/indexer endpoints, the
WalletConnect relay (`*.walletconnect.com/org`), and the MCP endpoint. All other
origins are blocked even if `host_permissions` would otherwise allow them.
`default-src 'none'` baseline ensures any unlisted directive type is blocked by default.
`frame-ancestors 'none'` applies globally (popup + approval + devtools).

### L1 — Content Script HTTPS Origin Check *(applied in Hardening VI)*
`routeToBackground()` in `provider-bridge.ts` now rejects non-https origins
(except `http://localhost`). The `content_scripts` manifest entry already restricts
injection to `https://*`; this is belt-and-suspenders defence-in-depth. ✅

### L3 — Approval Popup frame-ancestors *(applied in Hardening VI)*
`<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none';">` added
to `src/approval/index.html`. Also now covered globally by manifest CSP (Hardening VII). ✅

### L4 — Storage Quota Exhaustion *(applied in Hardening VI)*
`saveMeta()` and `saveEncryptedVault()` catch quota-exceeded errors and rethrow with
a user-readable message. ✅

### L5\* — WC Session localStorage Clear on Lock *(applied in Hardening VI)*
`App.tsx` listener clears all `wc@2:*` keys from popup localStorage when
`LOCK_STATE_CHANGED` with `lockState === "locked"` is received. ✅

---

## Remaining Open Items

**None.** All C/H/M/L issues are now closed.

Post-launch Phase 2 items (not security-blocking):
- XHR interception (x402 for legacy XMLHttpRequest-based apps)
- WalletConnect account `wcChain` migration for accounts created before chain-detection
- No-resolution-cache for enVoi (each lookup costs 1 VOI; session cache would help)
- Spending cap configuration UI (currently hardcoded default of 10 VOI; readable from meta)
- Approval TTL countdown indicator in the approval popup

---

## Fix Details — Hardening VIII

### L7 — Note Field Byte Truncation
**Files:** `src/background/message-handler.ts` (CHAIN_SEND_PAYMENT, CHAIN_SEND_ASSET)
The AVM note field limit is **1000 bytes**, not characters. The previous
`msg.note.slice(0, 1024)` then `TextEncoder().encode()` could produce up to 4096 bytes
for Unicode-heavy notes (4 bytes/char), causing node rejection.
Fix: encode first, then `slice(0, 1000)` on the resulting `Uint8Array`.
```typescript
// Before (wrong — char slice)
const noteText = msg.note ? msg.note.slice(0, 1024) : undefined;
const note = noteText ? new TextEncoder().encode(noteText) : undefined;

// After (correct — byte slice)
const note = msg.note
  ? new TextEncoder().encode(msg.note).slice(0, 1000)
  : undefined;
```

### L8 — WalletConnect Verification Frame CSP
**File:** `manifest.json`
WalletConnect opens `https://verify.walletconnect.org` in an iframe for session
verification. Without an explicit `frame-src`, the CSP falls back to `default-src 'none'`,
blocking the iframe and breaking WalletConnect pairing on certain wallets.
Fix: added `frame-src https://verify.walletconnect.org;` to the extension_pages CSP.
Also removed the redundant `<meta>` CSP tag from `approval/index.html` (Chrome ignores
`frame-ancestors` in meta tags, generating console noise).

### L9 — algosdk v3 `result.txid` Field Name
**File:** `src/background/chain-clients.ts`
algosdk v3 renamed `PostTransactionsResponse.txId` (camelCase) → `txid` (lowercase).
The old code returned `result.txId` which was always `undefined` on WalletConnect accounts,
causing the `PAYMENT-SIGNATURE` payload to be sent without a `txId`, rejected by servers as
`invalid_payment_signature`. Vault accounts were unaffected (they use `txn.txID()`).
Fix: `return result.txid` in `submitTransaction` and `submitTransactionGroup`.
Also added `waitForConfirmation` + `waitForIndexed` post-submit to eliminate `tx_not_found`
errors caused by indexer lag (indexers can lag several seconds behind algod confirmation).

---

## Cryptographic Foundations — Confirmed Sound

| Component | Implementation |
|-----------|---------------|
| Key derivation | PBKDF2-SHA-256, 600,000 iterations (OWASP 2023), 32-byte salt |
| Vault encryption | AES-GCM-256, fresh random 12-byte IV per write |
| Session-key pattern | PBKDF2 runs once on unlock; `CryptoKey` held in memory |
| Vault write mutex | `withVaultLock()` prevents concurrent corruption |
| SW suspension safety | `onSuspend` wipes `_vaultData` and `_sessionKey` |
| Origin authority | Background uses Chrome-provided `sender.url`, not `msg.origin` |
| Message bus | `BgRequest` union type enforced at compile time (TypeScript) |
| WC integration | Relay timeout, session poll, ACK grace wait all handled |

---

## Files Audited

```
manifest.json
package.json
src/background/index.ts
src/background/message-handler.ts
src/background/wallet-store.ts
src/background/x402-handler.ts
src/background/chain-clients.ts
src/content/index.ts
src/content/provider-bridge.ts
src/inpage/index.ts
src/popup/App.tsx
src/popup/components/AccountView.tsx
src/popup/hooks/useWalletConnect.ts
src/approval/index.tsx
src/shared/constants.ts
src/shared/utils/crypto.ts
src/shared/types/wallet.ts
src/shared/types/messages.ts
```

---

## Addendum — enVoi Name Resolution via UluMCP (March 2026)

**Scope:** `src/background/mcp-client.ts`, `src/background/message-handler.ts`,
`src/shared/types/messages.ts`, `src/popup/components/AccountView.tsx`

### Architecture

- Resolution of `.voi` names is handled entirely inside the background service worker
  (`mcp-client.ts`). The popup only sends a typed `VOI_RESOLVE_NAME` message and
  receives `{ address, displayName }` — it never touches MCP session IDs, payment
  headers, or private keys.
- All chain/payment logic follows the same path as existing x402 payments, reusing
  `getSuggestedParams`, `submitTransaction`, and the vault key from `walletStore`.

### Security properties

| Property | Implementation |
|---|---|
| Vault key only | `payVoi()` rejects WalletConnect accounts explicitly — no auto-signing with external wallets |
| Spending cap enforced | Amount validated against `meta.spendingCaps.nativeMicrounits` (default 10 VOI) before the transaction is built |
| Chain guard | `message-handler.ts` checks `activeChain === "voi"` and `lockState === "unlocked"` before delegating to `mcpResolveEnvoi` |
| Address validation | Resolved address is validated with `algosdk.isValidAddress` before being returned; untrusted JSON shapes are rejected |
| No silent send | `handleSend` blocks if a `.voi` name is present but unresolved — the raw name string can never reach the transaction builder |
| Cost visibility | User sees **"Resolve via enVoi (1 VOI)"** button label before any payment is triggered |
| Sensitive values | `Mcp-Session-Id` and `PAYMENT-SIGNATURE` are used only within `mcp-client.ts` and never logged or exposed to the UI |

### Trust boundaries

```
popup (UI only)
  │  VOI_RESOLVE_NAME { name }
  ▼
message-handler (chain + lock checks)
  │
  ▼
mcp-client (MCP session + x402 payment + tool call)
  │  HTTPS only
  ▼
mcp.ilovechicken.co.uk/mcp  (UluMCP — x402 gated, Voi mainnet)
  │
  ▼
api.envoi.sh  (enVoi name registry)
```

### Residual risks / Phase 2 items

- **WalletConnect resolution** not yet supported; users on WC accounts see a clear
  error message rather than a silent failure.
- **No resolution caching** — each call costs 1 VOI. A session-scoped cache would
  reduce unnecessary payments for repeated lookups of the same name.
- **enVoi API availability** — if `api.envoi.sh` is unreachable, the tool returns an
  error; no fallback resolver is implemented.

---

## Addendum — Bundle Security Review (March 2026)

**Scope:** Compiled `dist/` output after the enVoi integration and vm-polyfill fix.

### Findings resolved

| Finding | Severity | Resolution |
|---|---|---|
| `eval()` in background service-worker bundle | Medium | Excluded `vm` from `vite-plugin-node-polyfills` via `exclude: ["vm"]`; `eval()` count in bundle: 3 → **0** |
| `https://mcp.ilovechicken.co.uk` missing from `host_permissions` | Medium | Added `"https://mcp.ilovechicken.co.uk/*"` to `manifest.json`; Chrome MV3 service-worker cross-origin fetch no longer relies on server-side CORS headers |

### Root cause — eval() in vm polyfill

`asn1.js` (an algosdk transitive dependency) uses a `try { vm.runInThisContext(...) } catch { fallback }` pattern to create named constructor functions. When `vite-plugin-node-polyfills` bundled the `vm` module, this path executed `eval()` at runtime, violating the MV3 service-worker CSP (`script-src 'self'`).

With `exclude: ["vm"]` the `vm` module is externalized rather than polyfilled. At runtime in Chrome, `vm.runInThisContext(...)` throws a TypeError, the `catch` fallback fires, and anonymous constructors are used instead. Behaviour is functionally identical; `eval()` is never invoked.

### Confirmed clean — production bundle

| Category | Status |
|---|---|
| Source maps (.map files) | ❌ None present |
| Inline `sourceMappingURL` | ❌ None present |
| `eval()` occurrences | **0** (all bundles) |
| Hardcoded API keys / secrets | ❌ Not found |
| Hardcoded private keys / mnemonics | ❌ Not found |
| `.env` files in dist/ | ❌ None present |
| `dangerouslySetInnerHTML` | ❌ Not found |
| `unsafe-inline` / `unsafe-eval` in CSP | ❌ `script-src 'self'; object-src 'none';` ✓ |
| `<all_urls>` in host_permissions | ❌ Not present |
| `externally_connectable` (other-extension messaging) | ❌ Not defined |

### WalletConnect Project ID

`VITE_WC_PROJECT_ID` is baked into `constants.js` — this is expected and by design for any WalletConnect-enabled app (project IDs are public credentials, analogous to an OAuth client ID). The `.env` file containing the real value is gitignored. Mitigate quota abuse via rate-limit settings in the WalletConnect Cloud dashboard.
