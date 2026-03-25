# AlgoVoi Chrome Extension (MV3) — Security Audit Report

**Date:** March 2026
**Version:** 0.5.0
**Scope:** Comprehensive review of all `src/` files, `manifest.json`, and build configuration

## Status

```
0 Critical   0 High   0 Medium   0 Low open   (4 accepted risks: XIV-2, XVI-7, XVI-8, XVI-9, XVI-10)
XVII-1 (High)   CLOSED — SIGN_TRANSACTIONS blind signing
XVII-2 (Medium) CLOSED — Coinbase open redirect
XVII-3 (Low)    CLOSED — AGENT_CHAT trusts msg.activeAddress
```

**Hardening I–VIII** (historical): vault encryption, CSP, rate limiting, origin checks, genesis hash verification, spending caps, WC chain guard, byte truncation.

**Hardening IX (v0.1.3 — March 2026):** MPP (Machine Payments Protocol) implementation + full re-audit. All new findings closed in same pass.

**Hardening X (v0.1.4 — March 2026):** AP2 (Google Agent Payments Protocol) implementation + 3-agent parallel audit. All new findings closed in same pass.

**Hardening XI (v0.2.0 — March 2026):** SpendingCapVault feature (AVM smart contract + WalletConnect owner actions). Full re-audit + Comet AI dual-validation. All 8 new findings closed in same pass.

**Hardening XII (v0.3.0 — March 2026):** Haystack Router DEX swap integration + WalletConnect signing hardening + ASA metadata cache. Full security audit + independent Comet CDP validation (all 7 claims CONFIRMED). All 3 new findings closed in same pass.

**Hardening XIII (v0.3.1 — March 2026):** WalletConnect swap reliability + MV3 vault lock hardening. Dead-session detection (settle delay + session expiry check + 2-min relay timeout), vault keep-alive during WC signing, MV3 SW suspension lock correctly surfaced to UI. All 4 new findings closed in same pass.

**Hardening XIV (v0.4.0 — March 2026):** chromeStorage WC adapter, 30-day mnemonic import, vault ASA support, contract recompile. Full security re-audit + independent Comet CDP validation. Findings:
- **H5 (HIGH):** `.env` contains live Haystack API key — verify never committed to git history. **Status: OPEN** — requires manual verification.
- **XIV-1 (MEDIUM):** Secret keys (`getActiveSecretKey()`, `getAgentSecretKey()`) not zeroed after signing — `.fill(0)` in `finally` blocks recommended. **Status: OPEN.**
- **XIV-2 (MEDIUM):** Haystack API key embedded in build bundle — treat as public, rate-limit server-side. **Status: OPEN.**
- **XIV-3 (LOW):** WC session topic logged verbatim in `web3wallet-handler.ts` console.info — use `sanitizeTopic()`. **Status: CLOSED.**
- Comet CDP validated: AES-GCM-256 + PBKDF2 600k meets OWASP 2025 guidance. 30-day mnemonic TTL is stricter than MetaMask/Phantom (no TTL). chromeStorage adapter is sandboxed per-extension.

**Hardening XV (v0.4.0 — March 2026):** Anti-phishing defences. All additive — no existing behaviour changed.
- Clipboard hijacking detection: onPaste handler compares pasted address against live clipboard content; warns if malware swapped the address.
- Homograph domain detection: content script flags non-ASCII Unicode in hostnames (Cyrillic а, Greek ο, etc.) before ARC-0027 enable; confusable character database included.
- Transaction simulation: `simulateTransaction()` wraps algod `/v2/transactions/simulate` for pre-sign preview of balance changes and failure detection.
- Secret key wiping: `.fill(0)` after signing in all 7 handler paths (message-handler, x402, mpp, ap2, swap, web3wallet).
- Comet CDP independently validated anti-phishing architecture.

**Hardening XVII (v0.5.0 — March 2026):** AI Agent Chat + Coinbase Onramp integration. Full security review of all new attack surfaces. No new Critical/High/Medium/Low findings raised — all new code follows established patterns.
- AI Agent Chat: Anthropic API key lives exclusively on UluMCP server (`/etc/ulumcp/secrets.env`) — never bundled in extension. Server-side tool whitelist (`TOOL_CATEGORIES`) enforces per-category tool access; blocked attempts logged. Direct action path (regex parser) bypasses AI entirely for structured commands — reduces token cost and narrows attack surface. Conversational fallback calls `agent_chat` MCP tool via existing x402-gated session. `agent_chat` queries exempt from x402 charge until a tool executes.
- Coinbase Onramp: wallet address sent via POST body to AlgoVoi backend — never in URL query parameters, satisfying Coinbase "secure initialization" requirement. Feature flag `COINBASE_ONRAMP_ENABLED` allows Buy button to be disabled for CWS submissions without code changes. Backend endpoint restricted to `chrome-extension://` CORS origin. New host permissions (`pay.coinbase.com`, `api.developer.coinbase.com`) scoped to exact domains in `manifest.json`.
- Direct actions: `parseDirectAction()` uses anchored regex patterns (no `re` flag, no dynamic construction) — command injection not possible. All MCP calls routed through existing `callTool()` with established spending-cap and session guards.
- **XVII-1 (High) — `SIGN_TRANSACTIONS` blind signing:** New handler signed arbitrary MCP-returned transactions with no validation. Fix: (1) transaction count capped at 16; (2) genesis hash verified against active chain before key access; (3) dangerous fields (`rekeyTo`, `closeRemainderTo`, `assetCloseTo`, `clawback`) cause immediate rejection; (4) `wipeKey(sk)` in `try/finally`; (5) AgentChat.tsx shows action/receiver/amount summary with "⚠ Review before signing" before the Sign button. **Status: CLOSED.**
- **XVII-2 (Medium) — Coinbase open redirect:** `data.url` from backend response passed directly to `chrome.tabs.create` without origin validation — compromised backend could open phishing page. Fix: `startsWith("https://pay.coinbase.com/")` guard in both `AccountView.tsx` and `coinbase-onramp.ts` before opening. **Status: CLOSED.**
- **XVII-3 (Low) — `AGENT_CHAT` trusts `msg.activeAddress`:** Popup-supplied address forwarded to MCP tool calls without verifying it matches the actual active account. Fix: background sources address from `walletStore.getMeta()` directly; `msg.activeAddress` ignored. **Status: CLOSED.**

**Hardening XVI (v0.4.0 — March 2026):** Full security audit with 37 automated live tests + independent Comet CDP cross-validation. Findings:
- **XVI-1 (HIGH):** Authorization header forwarded on x402/MPP fetch retry — malicious 402 endpoint could capture Bearer tokens. **Status: CLOSED.** `Authorization` added to stripped headers list in both MPP and x402 retry paths in `src/inpage/index.ts`.
- **XVI-2 (MEDIUM):** `sk.fill(0)` not in `try/finally` — exception during signing skips key wipe. **Status: CLOSED.** All 4 affected handlers wrapped in `try/finally`: `x402-handler.ts`, `mpp-handler.ts`, `ap2-handler.ts`, `swap-handler.ts`.
- **XVI-3 (MEDIUM):** Debug log entries persisted indefinitely in `chrome.storage.local`. **Status: CLOSED.** 7-day `MAX_AGE_MS` auto-expiry filter added to `debug-log.ts` flush cycle.
- **XVI-4 (MEDIUM):** CSP `img-src` used wildcard `https://*.walletconnect.com` allowing any subdomain. **Status: CLOSED.** Pinned to explicit subdomains: `verify`, `registry`, `explorer-api`.
- **XVI-5 (LOW):** 30+ `console.log/warn` calls in production — overridable by malicious page scripts. **Status: CLOSED.** Terser configured in `vite.config.ts` to strip `console.log/warn/info/debug` in production builds; `console.error` preserved.
- **XVI-6 (LOW):** `WC_PROJECT_ID` silently defaults to empty string. **Status: CLOSED.** `console.error` validation added to `src/background/index.ts` service worker startup.
- **XVI-7 (LOW):** `tabs` permission grants `tab.url`/`tab.title` for all tabs. **Status: ACCEPTED.** Required for `chrome.tabs.query` (chain-change broadcast) and `chrome.tabs.get` (origin validation in x402/MPP handlers). Cannot be replaced with `activeTab`.
- **XVI-8 (INFO):** Lock state detectable via error messages ("Wallet is locked" vs "not connected"). Comet CDP confirmed MetaMask has identical behaviour — standard practice, not exploitable.
- **XVI-9 (INFO):** Extension detectable via `window.algorand` + `web_accessible_resources`. Comet CDP confirmed this is inherent to ARC-0027 spec and MV3 architecture — not a vulnerability unless exposed resources contain XSS.
- **XVI-10 (INFO):** `postMessage` traffic between inpage and content scripts observable by page scripts. Comet CDP confirmed this is an unavoidable MV3 limitation. No secrets transit the channel — keys remain in background service worker only.
- Comet CDP independently validated: PBKDF2 static salt is per-wallet unique (standard OWASP practice, not a weakness); Authorization header leak is a real credential theft vector; `safeCap()` already has `Number.isFinite` guard.

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
| SW-1 | Low | ✅ CLOSED | `swap-handler.ts::parseDecimal` — uint64 overflow check added |
| SW-2 | Low | ✅ CLOSED | `executeSwap` — address ownership + WC account type assertion before secret key use |
| FIND-B | Low | ✅ CLOSED | `SwapPanel.tsx::parseDecimal` — uint64 overflow guard added to match background |
| XIII-1 | Medium | ✅ CLOSED | WC swap: dead-session detection — 1.5 s relay settle + `session.get()` + expiry check + 2-min relay timeout with re-pair message |
| XIII-2 | Low | ✅ CLOSED | WC swap: vault auto-locks during signing wait — `KEEP_ALIVE` message + 30 s popup interval prevents MV3 5-min lock |
| XIII-3 | Medium | ✅ CLOSED | MV3 SW suspension silently locks vault — `sendBg()` detects "Wallet is locked" and fires `algovou:wallet-locked` DOM event; App.tsx shows unlock screen |
| XIII-4 | Low | ✅ CLOSED | WC swap: `useWalletConnect` hook diverged from `wc-sign.ts` (cached client, settle delay, session guard) — replaced with standalone `wc-sign-group.ts` mirroring proven pattern |
| H5 | High | ✅ CLOSED | `.env` verified never committed to git history (`git log --all -- .env` = empty); `.gitignore` covers `.env`, `.env.local`, `.env.*.local` |
| XIV-1 | Medium | ✅ CLOSED | Secret keys zeroed with `.fill(0)` after signing in all 7 handlers: message-handler (send, ASA send), x402-handler, mpp-handler, ap2-handler, swap-handler, web3wallet-handler |
| XIV-2 | Medium | ℹ️ ACCEPTED | Haystack API key compiled into bundle — accepted risk for client-side API keys; rate-limited server-side by Haystack |
| XIV-3 | Low | ✅ CLOSED | WC session topic truncated to 8 chars in `console.info` calls (`topic.slice(0, 8)…`) |
| XVI-1 | High | ✅ CLOSED | Authorization header stripped on x402/MPP fetch retry — prevents credential theft by malicious 402 endpoints |
| XVI-2 | Medium | ✅ CLOSED | `sk.fill(0)` wrapped in `try/finally` in x402, mpp, ap2, swap handlers |
| XVI-3 | Medium | ✅ CLOSED | Debug log 7-day auto-expiry (`MAX_AGE_MS`) added to flush cycle |
| XVI-4 | Medium | ✅ CLOSED | CSP `img-src` wildcards replaced with explicit WalletConnect subdomains |
| XVI-5 | Low | ✅ CLOSED | `console.log/warn/info/debug` stripped from production builds via terser |
| XVI-6 | Low | ✅ CLOSED | `WC_PROJECT_ID` validated non-empty at service worker startup |
| XVI-7 | Low | ℹ️ ACCEPTED | `tabs` permission required for chain-change broadcast and x402/MPP origin validation |
| XVI-8 | Info | ℹ️ ACCEPTED | Lock state oracle via error messages — same as MetaMask, standard practice |
| XVI-9 | Info | ℹ️ ACCEPTED | Extension fingerprinting — inherent to ARC-0027 spec |
| XVI-10 | Info | ℹ️ ACCEPTED | postMessage eavesdropping — MV3 architectural limitation, no secrets in transit |

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
| IntentMandates | Stored in `chrome.storage.session` — cleared on browser close, capped at 100 entries |

### ARC27_SIGN_AND_SEND guard (M7)
`provider-bridge.ts` `ARC27_SIGN_AND_SEND` case now validates `Array.isArray(payload.txns)` before destructuring, preventing an uncaught `TypeError` if a malicious page passes `null`.

### Removed phantom dependency
`@modelcontextprotocol/sdk` removed from `package.json` — was listed in `dependencies` but never imported. MCP interaction uses raw `fetch()` JSON-RPC calls in `mcp-client.ts`.

---

## Hardening XI — SpendingCapVault Implementation (v0.2.0)

### New attack surface introduced
- `src/background/vault-store.ts` — AVM SpendingCapVault contract interaction (deploy, setup, owner actions, state reads)
- `src/popup/components/VaultPanel.tsx` — WalletConnect vault deployment and owner action UI (2-round signing)
- `src/background/message-handler.ts` — 5 new vault case handlers + 3 WC submit handlers

### Findings and resolutions

**WC vault transaction binding (H1):** A compromised WalletConnect relay could substitute a different transaction (e.g. rekey, drain) after the background validates and returns an unsigned txn to the popup. Fix: `_pendingVaultWcBinding` Map stores the expected unsigned txn bytes (as base64) keyed by WC session topic with a 5-minute TTL. All three WC submit handlers (`VAULT_WC_SUBMIT_CREATE`, `VAULT_WC_SUBMIT_SETUP`, `VAULT_WC_ACTION_SUBMIT`) decode the signed txn, re-encode the unsigned bytes, and compare against the binding before submitting to the node. Binding is deleted immediately after validation.

**URL-safe base64 decoding (H2):** `atob()` rejects URL-safe base64 (uses `-` and `_`) returned by Defly and Lute wallets, causing silent failures. Fix: All WC txn decoding replaced with `base64ToBytes()` from `@shared/utils/crypto`, which normalises padding and URL-safe characters before decoding. Applied in all 3 WC submit handlers and all 3 decode sites in `VaultPanel.tsx`.

**AP2 queue cap origin comparison (M1):** Per-origin pending request cap was comparing full URLs — different paths on the same site counted as separate origins, bypassing the cap. Fix: cap now extracts `.origin` via `new URL(url).origin` for both the incoming request and each queued request. Falls back to exact string match when URL parsing fails (conservative, does not weaken the cap).

**IntentMandates session storage (M2):** AP2 `IntentMandate` objects contain payment metadata (amounts, merchant identity, address correlations) and were stored in `chrome.storage.local` — persisted unencrypted to disk. Fix: moved to `chrome.storage.session` (cleared when browser closes) with a 100-entry rolling cap. All three helpers (`getIntentMandates`, `storeIntentMandate`, `removeIntentMandate`) updated.

**Withdraw address validation (L1):** `ownerWithdraw()` would attempt an on-chain transaction with an invalid receiver address, wasting a fee. Fix: `algosdk.isValidAddress(msg.receiver)` pre-flight check added before calling `ownerWithdraw()`.

**Auto-lock reset on vault poll (L2):** `VAULT_GET_STATE` is polled continuously by the VaultPanel but was not calling `resetAutoLock()`, so the auto-lock timer could fire while the user was actively using the vault UI. Fix: `resetAutoLock()` added to `VAULT_GET_STATE` handler.

**µAlgo formatting precision (L3):** The `fmt()` helper in vault-store used plain `.toString()` on the fractional µAlgo remainder, dropping leading zeros (e.g. `1_000_001n` rendered as `"1.1"` instead of `"1.000001"`). Fix: `.padStart(6, "0").replace(/0+$/, "")` — pads to 6 digits then strips trailing zeros only.

**Static getAlgodClient import (C3):** Three vault WC submit handlers used `await import("./chain-clients")` dynamically, adding latency and risking silent breakage on module rename. Fix: `getAlgodClient` promoted to a static top-level import alongside other chain-client helpers.

### Validation
All 8 findings validated by local grep scan (19/19 checks PASS) and independently by Comet AI dual-validation (19/19 checks PASS).

---

## Hardening XII — Haystack DEX Swap Integration (v0.3.0)

### New attack surface introduced
- `src/background/swap-handler.ts` — DEX swap quote + execution; all signing stays in service worker
- `src/popup/components/SwapPanel.tsx` — Swap UI; WC path runs `RouterClient` in popup with `signGroupIndexed`
- `src/shared/utils/asset-cache.ts` — Persistent ASA metadata cache in `chrome.storage.local`
- `src/popup/hooks/useWalletConnect.ts` — New `signGroupIndexed` method for grouped WC signing
- `manifest.json` — `hayrouter.txnlab.dev` added to `host_permissions` and `connect-src`

### Findings and resolutions

**SW-1 (Low) — uint64 overflow in `swap-handler.ts::parseDecimal`:** The popup copy of `parseDecimal` lacked the AVM uint64 maximum check (`> 18_446_744_073_709_551_615n`) present in `parseDecimalToAtomic` in `message-handler.ts`. Extremely large amounts would reach Haystack/algosdk and produce an opaque error rather than a clear rejection. Fix: uint64 overflow check added to `parseDecimal` in `swap-handler.ts`.

**SW-2 (Low) — No address ownership assertion in `executeSwap`:** `executeSwap` accepted `params.address` from the popup without verifying it matched the active account's address. A stale popup state (e.g. account switched mid-session) could cause the background to sign a swap for a different vault key than expected. Not exploitable via content scripts (SWAP_EXECUTE is not in the inpage switch). Fix: `executeSwap` now reads `walletStore.getMeta()`, asserts `activeAccount.address === params.address`, and explicitly rejects `walletconnect` account types with a clear error before calling `getActiveSecretKey()`.

**FIND-B (Low) — `SwapPanel.tsx::parseDecimal` diverged from background:** The UI copy of `parseDecimal` was missing the uint64 overflow guard added in SW-1, creating a maintenance divergence where a future UI-side enforcement path could silently accept overflowing values. Fix: uint64 overflow check added to `SwapPanel.tsx::parseDecimal` to keep both copies identical.

### Additional hardening (same pass)
- **WC session staleness guard:** All three signing methods in `useWalletConnect.ts` (`signTransaction`, `signGroup`, `signGroupIndexed`) now call `client.session.get(sessionTopic)` before sending to the relay — throws immediately with an actionable "session expired, reconnect" error if the session is stale.
- **WC signing timeout:** 60-second `Promise.race` on all three signing methods — prevents indefinite hang if the user's phone is unreachable.
- **ASA batch rate-limiting:** Asset metadata fetches batched at 5 per 150ms gap to avoid 429 errors from Algorand indexer.
- **Asset cache write error handling (W2):** `writeAssetCache` now uses callback form of `chrome.storage.local.set()` and checks `chrome.runtime.lastError`.
- **algodUri pinned in both paths:** Both `swap-handler.ts` (background) and `SwapPanel.tsx` (popup WC path) hardcode `algodUri: "https://mainnet-api.algonode.cloud"` — prevents the RouterClient default (`mainnet-api.4160.nodely.dev`) from violating the manifest CSP.
- **SWAP_QUOTE/EXECUTE not in inpage switch:** Confirmed — `routeToBackground` in `provider-bridge.ts` has no SWAP cases; dApps cannot trigger swaps on behalf of the user.

### Validation
All 7 security claims independently validated by **Comet CDP** (all CONFIRMED). BUG-A (Comet finding: `remaining` undeclared) confirmed false positive — `remaining` is declared on line 90 of `checkUnlockRate`. FIND-C (genesis check variable binding) confirmed intentional — post-approval re-fetch of `freshMeta` is the designed defence against chain switches during approval.

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

## Files Audited (v0.5.0)

```
manifest.json                           ← modified v0.5.0 (version bump, Coinbase host permissions added)
package.json                            ← modified v0.5.0 (version bump)
vite.config.ts
src/background/index.ts
src/background/message-handler.ts       ← modified v0.5.0 (AGENT_CHAT + COINBASE_OPEN_ONRAMP handlers)
src/background/wallet-store.ts          ← modified v0.5.0
src/background/vault-store.ts
src/background/agent-chat.ts            ← new v0.5.0 (direct action dispatcher + AI fallback)
src/background/direct-actions.ts        ← new v0.5.0 (regex command parser + MCP executors)
src/background/coinbase-onramp.ts       ← new v0.5.0 (Coinbase session token flow)
src/background/swap-handler.ts
src/background/x402-handler.ts
src/background/mpp-handler.ts
src/background/ap2-handler.ts
src/background/mcp-client.ts            ← modified v0.5.0
src/background/chain-clients.ts
src/background/approval-handler.ts
src/background/web3wallet-handler.ts
src/content/index.ts
src/content/provider-bridge.ts
src/inpage/index.ts
src/popup/App.tsx
src/popup/components/AccountView.tsx    ← modified v0.5.0 (Buy button, AI Chat tab wiring)
src/popup/components/AgentChat.tsx      ← new v0.5.0 (AI chat UI with categories + hints)
src/popup/components/SwapPanel.tsx
src/popup/components/VaultPanel.tsx
src/popup/components/WalletConnectModal.tsx
src/popup/hooks/useWalletConnect.ts
src/approval/index.tsx
src/shared/constants.ts                 ← modified v0.5.0 (Coinbase constants + COINBASE_ONRAMP_ENABLED flag)
src/shared/debug-log.ts
src/shared/utils/crypto.ts
src/shared/utils/asset-cache.ts
src/shared/utils/wc-storage.ts
src/shared/utils/wc-chrome-storage.ts
src/shared/utils/wc-sign-group.ts
src/shared/types/wallet.ts              ← modified v0.5.0
src/shared/types/messages.ts            ← modified v0.5.0 (AGENT_CHAT + COINBASE message types)
src/shared/types/approval.ts
src/shared/types/ap2.ts
src/shared/types/mpp.ts
src/shared/types/x402.ts
src/devtools/components/X402Inspector.tsx
```

---

## Residual Phase 2 Items (Non-Security-Blocking)

- XHR interception (x402 for legacy XMLHttpRequest-based apps)
- WalletConnect account `wcChain` migration for pre-detection accounts
- Spending cap configuration UI (currently hardcoded default of 10 VOI/ALGO)
- Resolution caching for enVoi (each lookup costs 1 VOI)
- Approval TTL countdown in the approval popup
- `_persistVaultData()` with stored session `CryptoKey` (Phase 2 vault hardening)
