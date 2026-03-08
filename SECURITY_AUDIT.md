# AlgoVoi Chrome Extension (MV3) — Security Audit Report

**Date:** March 2026
**Scope:** Comprehensive review of all `src/` files, `manifest.json`, and build configuration

## Final Status: Release-Ready (GitHub / Unpacked)

```
0 Critical   0 High   1 Medium open   6 Low open
```

All critical and high-severity issues have been fixed and verified. All previously identified
medium-severity issues are closed. One new medium (M6 — migration ghost) and two new low items
(L7, L8) were found during the final independent adversarial review in March 2026 and are
tracked below. The remaining open items do not block release for GitHub publication or unpacked
extension use.

---

## Issue Register

| ID   | Severity | Status | Fix Applied |
|------|----------|--------|-------------|
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
| L2   | Low      | ✅ CLOSED | Extension pages not frameable by design; confirmed |
| L5   | Low      | ✅ CLOSED | `CHAIN_SUBMIT_SIGNED` now requires unlocked wallet |
| L6   | Low      | ✅ CLOSED | CSP already correct for MV3; confirmed |
| L1   | Low      | 🔵 OPEN  | Content script HTTPS origin check (not exploitable) |
| L3   | Low      | 🔵 OPEN  | Approval popup `frame-ancestors` header (not frameable) |
| L4   | Low      | 🔵 OPEN  | Storage quota exhaustion handling (not realistic) |
| L5\* | Low      | 🔵 OPEN  | WC session localStorage clear on lock (partial — see note) |
| M6   | Medium   | 🔵 OPEN  | H2 migration ghost — plaintext `connectedSites` not deleted after vault migration |
| L7   | Low      | 🔵 OPEN  | EnvoiPage BigInt crash — non-integer MCP amount causes SyntaxError in approval popup |
| L8   | Low      | 🔵 OPEN  | `devtools_page` active in production manifest (increases attack surface) |

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

### L6 — Content Security Policy
**File:** `manifest.json`
`"script-src 'self'; object-src 'none';"` — correct MV3 `extension_pages` key.
No `unsafe-inline`, no `eval`. Confirmed.

---

## Remaining Open Items (Low — Post-Launch Polish)

### L1 — Content Script HTTPS Origin Check
The `content_scripts` manifest entry matches only `https://*` so the content script
is never injected into HTTP, `file://`, or `data:` pages in production. Adding an
explicit `origin.startsWith("https://")` check inside `routeToBackground()` would
be pure defence-in-depth. The background's `sender.url` check is authoritative.

Recommended one-liner:
```ts
if (!origin.startsWith("https://") && origin !== "http://localhost") throw ...
```

### L3 — Approval Popup frame-ancestors
The approval popup HTML could include:
```html
<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none';">
```
Not frameable by design (`chrome-extension://` resources cannot be embedded by
web pages); this would be cosmetic belt-and-suspenders hardening only.

### L4 — Storage Quota Exhaustion
`chrome.storage.local.set()` calls are not wrapped for `QUOTA_BYTES` errors.
Realistic quota is never reached for typical usage (< 1 KB per account).
Wrap `saveEncryptedVault` / `saveMeta` with `catch(QuotaExceeded)` for a
user-friendly error message in the unlikely edge case.

### L5\* — WC Session localStorage Clear on Lock
WalletConnect SDK session data (`wc@2:client:session`, `wc@2:core:keychain`, etc.)
persists in the extension popup localStorage after wallet lock. The concrete
exploit path (submitting via `CHAIN_SUBMIT_SIGNED` without unlock) is now closed.
Clearing WC session storage on lock would be additional defence-in-depth, but
requires the popup to receive a `"WALLET_LOCKED"` message and call
`signClient.core.storage.removeItem()` for each WC key — non-trivial and deferred.

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

---

## Addendum — Final Independent Adversarial Review (March 2026)

**Scope:** Full codebase re-read after Hardenings I–V. Focused on silent-signing paths,
page-controlled data trust, lock races, cross-chain confusion, plaintext sensitive data
exposure, malformed-input crashes, and publication safety.

**Verdict:** Release-ready for GitHub and unpacked extension. Three new findings (M6, L7, L8)
require attention before Chrome Web Store submission.

### M6 — H2 Migration Ghost (Medium — Open)

**File:** `src/background/wallet-store.ts` lines 216–221

After the H2 migration copies `meta.connectedSites` into the encrypted vault,
`meta.connectedSites` is never deleted from `chrome.storage.local`. Any user who
unlocks once after upgrading retains a plaintext copy of their browsing-history
correlation data at rest indefinitely.

**Fix:** After `await persistVaultData()`, delete and re-save meta:
```ts
delete meta.connectedSites;
await saveMeta(meta);
```

**Risk until fixed:** Plaintext site↔address mapping persists in local storage. No
funds at risk; no active exfiltration path. Severity: Medium.

---

### L7 — EnvoiPage BigInt Crash (Low — Open)

**File:** `src/approval/index.tsx` line 405
**Related:** `src/background/mcp-client.ts` `callTool()` / `payVoi()`

`callTool()` passes `pr.amount` to `requestApproval()` before the `!/^\d+$/`
format guard in `payVoi()` runs. The approval popup renders
`BigInt(approval.amount)` — if a malicious or buggy MCP server sends `"1.5"`,
`"abc"`, or `null`, this throws `SyntaxError`, crashing the EnvoiPage for the
5-minute TTL window.

**No funds at risk** — `payVoi()` never executes if the popup crashes. The user
is locked out of enVoi resolution for the TTL period only.

**Fix (two-part):**
1. In `mcp-client.ts` `callTool()`, validate `pr.amount` with `!/^\d+$/` *before*
   calling `requestApproval()` (move the guard from `payVoi()` to the call site).
2. In `approval/index.tsx` `EnvoiPage`, wrap the `BigInt()` call defensively:
   ```ts
   const amountBig = /^\d+$/.test(String(approval.amount))
     ? BigInt(approval.amount) : 0n;
   ```

---

### L8 — `devtools_page` Active in Production (Low — Open)

**File:** `manifest.json`

The `"devtools_page"` key is present in the production manifest, enabling the
DevTools panel (TxnInspector, X402Inspector, BazaarPanel) for all users. This
increases the attack surface and adds download weight unnecessarily for
non-developer installs.

**Fix options (choose one):**
- Gate via a separate `manifest.devtools.json` used only in dev builds
- Gate in `vite.config.ts`: include `devtools_page` only when `mode !== "production"`
- Accept as-is for the current release if the DevTools panel is a deliberate feature

---

### Publication Checklist (Web Store)

Before Chrome Web Store submission, in addition to fixing M6, L7, L8:

| Item | Status |
|------|--------|
| `VITE_WC_PROJECT_ID` set in release `.env` | Manual step required |
| Privacy policy URL in `manifest.json` | Not yet present |
| Host permission justification for `mcp.ilovechicken.co.uk` | Narrative ready (enVoi name resolution) |
| Single-purpose description covers all features | README / store listing needed |
