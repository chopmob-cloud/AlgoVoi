# AlgoVoi Chrome Extension (MV3) — Security Audit Report

**Date:** March 2026
**Version:** 0.1.4
**Scope:** Comprehensive review of all `src/` files, `manifest.json`, and build configuration

## Final Status: All Issues Resolved

```
0 Critical   0 High   0 Medium   0 Low open
```

**Hardening I–VIII** (historical): vault encryption, CSP, rate limiting, origin checks, genesis hash verification, spending caps, WC chain guard, byte truncation.

**Hardening IX (v0.1.3 — March 2026):** MPP (Machine Payments Protocol) implementation + full re-audit. All new findings closed in same pass.

**Hardening X (v0.1.4 — March 2026):** AP2 (Google Agent Payments Protocol) implementation + 3-agent parallel audit. All new findings closed in same pass.

---

## Issue Register

| ID | Severity | Status | Description |
|---|---|---|---|
| C1 | Critical | ✅ CLOSED | genesisID check before ARC27_SIGN_TXNS signing |
| C2 | Critical | ✅ CLOSED | Unlock rate-limit moved to `chrome.storage.session` |
| C3 | Critical | ✅ CLOSED | Vault persistence confirmed correct |
| H1 | High | ✅ CLOSED | Genesis hash verified on `WALLET_SET_CHAIN` |
| H2 | High | ✅ CLOSED | `connectedSites` encrypted in vault; migration on unlock |
| H3 | High | ✅ CLOSED | Per-origin x402 queue capped at 5 pending requests |
| H4 | High | ✅ CLOSED | `mcp-client.ts` spending cap uses `safeCap()` guard |
| M1 | Medium | ✅ CLOSED | uint64 overflow check in `parseDecimalToAtomic` |
| M2 | Medium | ✅ CLOSED | Duplicate txn errors swallowed; real failures propagate (x402 + MPP) |
| M3 | Medium | ✅ CLOSED | Session headers stripped on x402/MPP retry |
| M4 | Medium | ✅ CLOSED | Dead-code `secureCompare()` with timing leak removed |
| M5 | Medium | ✅ CLOSED | Spending caps read from `meta.spendingCaps` with `safeCap()` defaults |
| M6 | Medium | ✅ CLOSED | CSP `connect-src` added; `default-src 'none'` baseline set |
| M7 | Medium | ✅ CLOSED | `ARC27_SIGN_AND_SEND` validates `Array.isArray(txns)` before use |
| L1 | Low | ✅ CLOSED | HTTPS origin guard in `routeToBackground()` |
| L2 | Low | ✅ CLOSED | Extension pages not frameable; confirmed |
| L3 | Low | ✅ CLOSED | `frame-ancestors 'none'` in approval/index.html |
| L4 | Low | ✅ CLOSED | Storage quota errors caught and re-thrown |
| L5 | Low | ✅ CLOSED | `CHAIN_SUBMIT_SIGNED` requires unlocked wallet |
| L5* | Low | ✅ CLOSED | WC session localStorage cleared on lock |
| L6 | Low | ✅ CLOSED | CSP correct for MV3; confirmed |
| L7 | Low | ✅ CLOSED | Note field: encode-then-slice to 1000 bytes (x402, MPP, CHAIN_SEND_*) |
| L8 | Low | ✅ CLOSED | `frame-src https://verify.walletconnect.org` added to CSP |
| L9 | Low | ✅ CLOSED | algosdk v3 `result.txid` field name corrected |
| L10 | Low | ✅ CLOSED | MPP duplicate txn detection upgraded to anchored word-boundary regex |
| L11 | Low | ✅ CLOSED | `alarms` permission removed (was declared but never used) |
| L12 | Low | ✅ CLOSED | `@modelcontextprotocol/sdk` phantom dependency removed |
| I1 | Info | ✅ CLOSED | MPP amount > 0 + decimals 0–19 validated at parse time |
| I2 | Info | ✅ CLOSED | MPP TTL 6-min safety cleanup if popup crashes |
| I3 | Info | ✅ CLOSED | MPP recipient address truncated in approval UI |
| I4 | Info | ✅ CLOSED | Dual-protocol warning if both MPP + x402 headers present |

---

## Hardening IX — MPP Implementation (v0.1.3)

### New attack surface introduced
- `src/background/mpp-handler.ts` — parses `WWW-Authenticate: Payment` header, builds/signs AVM txn, opens approval popup
- `src/inpage/index.ts` — MPP detection in fetch interceptor before x402 check
- `src/approval/index.tsx` — `MppPage` component

### Findings and resolutions

**Amount validation (I1):** MPP amount `> 0` and decimals within `0–19` now validated in `decodeMppAvmRequest()` — before queuing, not at sign time. Zero/negative amounts rejected immediately.

**TTL cleanup (I2):** `handleMpp()` sets a 6-minute `setTimeout` safety cleanup for `_pendingMppRequests` in case the popup crashes without sending `MPP_APPROVE`/`MPP_REJECT`.

**Recipient truncation (I3):** `MppPage` shows `addr.slice(0,8)…addr.slice(-8)` with full address in `title` tooltip.

**Dual-protocol warning (I4):** `console.warn` emitted if both `WWW-Authenticate: Payment` and `PAYMENT-REQUIRED` headers appear on the same 402 response.

**Note byte truncation (L7):** All note fields encode to UTF-8 bytes first, then `.slice(0, 1000)` — prevents splitting multi-byte characters.

**Duplicate txn regex (L10):** Upgraded from broad `String.includes("already")` to anchored word-boundary regex `/\b(already in ledger|txn already exists|duplicate transaction|transaction already)\b/i` in both x402 and MPP handlers.

**Spending caps (H4, M5):** `safeCap()` helper validates stored cap values before `BigInt` conversion — guards against zero, negative, NaN, or Infinity from corrupted storage. Applied to x402, MPP, and mcp-client handlers.

---

## Hardening X — AP2 Implementation (v0.1.4)

### New attack surface introduced
- `src/background/ap2-handler.ts` — verifies CartMandate, builds/signs PaymentMandate (SHA-256 hash + ed25519), stores IntentMandates
- `src/shared/types/ap2.ts` — AP2 type definitions
- `src/inpage/index.ts` — `window.algorand.ap2.requestPayment()` and `getIntentMandates()`
- `src/approval/index.tsx` — `Ap2Page` component with expiry countdown

### Security properties of AP2 implementation

| Property | Implementation |
|---|---|
| No AVM transaction | AP2 signs a credential only — no on-chain transaction submitted |
| CartMandate stored in full | Full `CartMandate` retained in `PendingAp2Approval` for correct SHA-256 hash |
| No MX prefix | `signBytes` called without ARC-1 `MX` prefix — AP2 credentials are not ARC-0027 operations |
| WalletConnect blocked | AP2 signing rejected for WC accounts (no vault key access) |
| Queue cap | Per-page limit of 5 pending AP2 approval requests |
| TTL cleanup | 6-minute safety cleanup if approval popup crashes |
| Expiry enforcement | `Ap2Page` disables Approve button when `CartMandate.expiry` has passed |
| IntentMandates | Stored in `chrome.storage.local` (not encrypted — not secret) |

### ARC27_SIGN_AND_SEND guard (M7)
`provider-bridge.ts` `ARC27_SIGN_AND_SEND` case now validates `Array.isArray(payload.txns)` before destructuring, preventing an uncaught `TypeError` if a malicious page passes `null`.

### Removed phantom dependency
`@modelcontextprotocol/sdk` removed from `package.json` — was listed in `dependencies` but never imported. MCP interaction uses raw `fetch()` JSON-RPC calls in `mcp-client.ts`.

---

## Cryptographic Foundations — Confirmed Sound

| Component | Implementation |
|---|---|
| Key derivation | PBKDF2-SHA-256, 600,000 iterations (OWASP 2023), 32-byte salt |
| Vault encryption | AES-GCM-256, fresh random 12-byte IV per write |
| Session-key pattern | PBKDF2 runs once on unlock; `CryptoKey` held in memory, never extracted |
| Vault write mutex | `withVaultLock()` prevents concurrent corruption |
| SW suspension safety | `onSuspend` wipes `_vaultData` and `_sessionKey` |
| Origin authority | Background uses Chrome-provided `sender.url`, not `msg.origin` |
| Message bus | `BgRequest` union type enforced at compile time (TypeScript) |
| AP2 signing | `algosdk.signBytes` (ed25519) — no MX prefix, not an ARC-0027 operation |
| AP2 hashing | `crypto.subtle.digest("SHA-256", ...)` — Web Crypto API, no polyfill |
| x402/MPP note field | Encode to UTF-8 bytes first, then `slice(0, 1000)` |
| Spending caps | `safeCap()` validates before BigInt conversion; zero/negative → default |
| Duplicate txn detection | Anchored word-boundary regex, not substring search |

---

## Confirmed Non-Issues

| Area | Finding |
|---|---|
| eval() | Zero occurrences; `vm` polyfill excluded from bundle |
| dangerouslySetInnerHTML | Not used anywhere |
| Hardcoded secrets | None; WC project ID is a public credential |
| Remote code execution | No dynamic import() of remote URLs |
| DOM access in service worker | None; background uses only Chrome APIs and `fetch()` |
| Clipboard without user gesture | All four clipboard writes are user-click handlers |
| Obfuscated code | None; all source is readable TypeScript |
| Supply chain | All dependencies are well-known packages; phantom dep removed |
| CSP unsafe-eval / unsafe-inline | Not present in script-src |

---

## Files Audited (v0.1.4)

```
manifest.json
package.json
src/background/index.ts
src/background/message-handler.ts
src/background/wallet-store.ts
src/background/x402-handler.ts
src/background/mpp-handler.ts
src/background/ap2-handler.ts
src/background/mcp-client.ts
src/background/chain-clients.ts
src/background/approval-handler.ts
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
src/shared/types/approval.ts
src/shared/types/ap2.ts
src/shared/types/mpp.ts
```

---

## Residual Phase 2 Items (Non-Security-Blocking)

- XHR interception (x402 for legacy XMLHttpRequest-based apps)
- WalletConnect account `wcChain` migration for pre-detection accounts
- Spending cap configuration UI (currently hardcoded default of 10 VOI/ALGO)
- Resolution caching for enVoi (each lookup costs 1 VOI)
- Approval TTL countdown in the approval popup
- `_persistVaultData()` with stored session `CryptoKey` (Phase 2 vault hardening)
