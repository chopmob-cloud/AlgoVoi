# AlgoVoi — CDP Security Compliance Summary

**Extension:** AlgoVoi v0.5.0 — Web3 Wallet for Algorand + Voi
**Architecture:** Chrome MV3 (client-side) + AlgoVoi backend (Coinbase session token proxy)
**Date:** March 2026
**Audit status:** 0 Critical | 0 High | 0 Medium | 0 Low open issues
**Hardening cycles:** 17 | **Files audited:** 43

---

## CDP Requirements Mapping

| CDP Requirement | Status | How AlgoVoi Meets It |
|---|---|---|
| **CORS — explicit origins, no wildcards** | Meets | Extension CSP uses `default-src 'none'` with explicit domain allowlists. Coinbase session proxy endpoint CORS-restricted to `chrome-extension://` origin only. |
| **Authenticated endpoints** | Meets | PBKDF2-SHA-256 (600k iterations) vault unlock required before any signing or payment. 5-min auto-lock. 5-attempt rate limit with 30s lockout. |
| **Wallet signature auth** | Exceeds | ARC-0027 signing with `crypto.randomUUID()` anti-replay. Secret keys AES-256-GCM encrypted at rest, zeroed with `sk.fill(0)` in `try/finally` across all 7 signing paths. |
| **Session tokens — short-lived, single-use** | Meets | Approval requests: 5-min TTL, consumed on use. Agent requests: 6-min TTL. Auto-pruned on expiry. |
| **API keys never exposed to client** | Meets | Anthropic API key (AI Agent Chat) and Coinbase CDP credentials live exclusively on the AlgoVoi backend (`/etc/ulumcp/secrets.env`). Two client-side keys exist by design: WalletConnect Project ID (public per spec) and Haystack API key (rate-limited server-side). |

---

## Security Posture

| Area | Implementation |
|---|---|
| **Encryption** | AES-256-GCM + PBKDF2-SHA-256 (600k iterations, 256-bit salt) via Web Crypto API |
| **Key management** | Encrypted vault in `chrome.storage.local`; keys decrypted only for signing then zeroed |
| **CSP** | `default-src 'none'`; no `unsafe-inline`/`unsafe-eval`; pinned subdomains on `img-src` |
| **Permissions** | Minimal: `storage`, `tabs`, `windows`, `alarms`. Host permissions restricted to known nodes. |
| **Anti-phishing** | Homograph detection, clipboard hijack check, transaction simulation, dangerous field warnings |
| **Input validation** | Address (`isValidAddress`), amount (Uint64 overflow + spending caps), origin (HTTPS-only) |
| **Network** | HTTPS/WSS only. Auth/Cookie/CSRF headers stripped on payment retries. |
| **Build** | Console stripped in production (Terser). No source maps shipped. `vm` polyfill excluded. |

---

## Accepted Risks

| ID | Level | Description |
|---|---|---|
| XIV-2 | Medium | Haystack API key in bundle — rate-limited server-side |
| XVI-7 | Info | `tabs` permission — required for chain broadcast |
| XVI-8–10 | Info | Lock state / extension / postMessage detectable — industry standard, no secrets exposed |

---

## Conclusion

AlgoVoi v0.5.0 meets or exceeds all applicable CDP security requirements.
Cryptography follows OWASP 2025 guidance. Coinbase Onramp is integrated via
a secure session-token proxy — wallet addresses are POSTed to the AlgoVoi
backend (never in URL parameters), and Coinbase credentials are handled
exclusively server-side. Anthropic API key for AI Agent Chat is similarly
server-side only.

Full audit: `SECURITY_AUDIT.md` — independently validated by Comet CDP, March 2026.
