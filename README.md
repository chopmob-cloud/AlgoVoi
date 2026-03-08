# AlgoVoi

A Manifest V3 Chrome extension — Web3 wallet for **Algorand** and **Voi** with native [x402 HTTP payment](https://x402.org) support and on-chain `.voi` name resolution via [enVoi](https://envoi.sh).

---

## Features

- **Dual-chain wallet** — Algorand mainnet and Voi mainnet from a single popup; switch chains instantly with a toggle
- **ARC-0027 provider** — injects `window.algorand` into every HTTPS page; compatible with Pera, Defly, and Lute dApps
- **x402 automatic payments** — intercepts HTTP 402 responses, prompts user approval, signs and submits the payment transaction, then retries the original request transparently
- **WalletConnect v2** — pair with Pera, Defly, or Voi Wallet; chain-specific sessions detected automatically from CAIP-10 account namespaces; chain selector lets you confirm Algorand vs Voi before scanning
- **enVoi name resolution** — type `shelly.voi` in the Send modal; the extension resolves it to a Voi address via UluMCP (costs ~1 VOI, paid automatically within your spending cap)
- **Spending caps** — configurable per-payment ceiling (default 10 ALGO / 10 VOI / 10 USDC) enforced before any automatic payment is signed
- **Hardware-wallet-ready architecture** — Ledger support stubbed; vault is ARC-0047-style PBKDF2 → AES-GCM 256-bit encrypted at rest
- **DevTools panel** — inspect live x402 payment flows, transaction history, and Bazaar listings from Chrome DevTools

---

## Architecture

```
src/
├── background/        Service worker — wallet-store, chain-clients, x402-handler,
│   │                  message-handler, mcp-client
│   ├── wallet-store.ts      PBKDF2 + AES-GCM vault; in-memory key after unlock
│   ├── chain-clients.ts     Algorand + Voi algosdk clients (shared surface)
│   ├── x402-handler.ts      x402 payment queue, approval popup, signing
│   ├── mcp-client.ts        enVoi name resolution via UluMCP (x402 gated)
│   └── message-handler.ts   Chrome runtime message router
├── content/           Content script — bridges inpage ↔ background messages
├── inpage/            Injected into pages — window.algorand provider + fetch intercept
├── popup/             React wallet UI (360 px) — accounts, send, receive, settings
├── approval/          x402 payment approval popup (400 px)
└── devtools/          Chrome DevTools panel — TxnInspector, X402Inspector, BazaarPanel
```

**Message flow:**
```
inpage  ←→  content   (window.postMessage, source: "algovou-inpage/content")
content ←→  background (chrome.runtime.sendMessage, returns { ok, data, error })
```

**x402 flow:**
```
page fetch → 402 → content → background queues request → approval popup opens
→ user approves → background signs + submits txn → notifies inpage → fetch retried
```

**enVoi resolution flow:**
```
Send modal → VOI_RESOLVE_NAME → message-handler (chain + lock checks)
  → mcp-client → POST /mcp (init session) → POST /mcp (tools/call)
  → 402 → pay 1 VOI on-chain → retry with PAYMENT-SIGNATURE
  → SSE result → algosdk.isValidAddress → { address, displayName }
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Chrome 120+ (Manifest V3 service worker required)

### Install and build

```bash
git clone https://github.com/MaidToShelly/algovou
cd algovou
npm install
cp .env.example .env     # fill in your WalletConnect project ID
npm run build
```

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `dist/` folder

### Development watch mode

```bash
npm run dev   # rebuilds on every file save
```

---

## Testing

```bash
npm test               # run all tests once
npm run test:watch     # watch mode
npm run test:coverage  # lcov coverage report
```

Tests live in `tests/` and use [Vitest](https://vitest.dev) with Node environment. All
Chrome extension APIs are stubbed per-test with `vi.stubGlobal`; fetch is mocked with
`vi.stubGlobal("fetch", ...)` response queues. No network calls are made during tests.

**Coverage target files:** `src/background/mcp-client.ts`, `src/background/message-handler.ts`

---

## Configuration

Copy `.env.example` to `.env` and fill in the required values:

```env
# WalletConnect v2 — register a free project at https://cloud.walletconnect.com
VITE_WC_PROJECT_ID=your_project_id_here

# Public HTTPS URL shown to mobile wallets in WalletConnect session metadata.
# Must be https:// — chrome-extension:// URLs are rejected by Pera/Defly/Lute.
VITE_WC_APP_URL=https://your-app-domain.example

# Optional: override default node URLs
VITE_ALGORAND_NODE_URL=https://mainnet-api.algonode.cloud
VITE_ALGORAND_INDEXER_URL=https://mainnet-idx.algonode.cloud
VITE_VOI_NODE_URL=https://mainnet-api.voi.nodely.dev
VITE_VOI_INDEXER_URL=https://mainnet-idx.voi.nodely.dev
```

All other configuration (MCP endpoint, spending caps, chain genesis hashes) is baked into
`src/shared/constants.ts` and verified at build time.

---

## Manifest Permissions

| Permission | Purpose |
|---|---|
| `storage` | Encrypted vault + wallet metadata |
| `alarms` | Auto-lock timer |
| `tabs` + `activeTab` | x402 payment approval context; chain-change broadcast |
| `notifications` | Payment confirmation notifications |
| `windows` | WalletConnect pairing popup |

**Host permissions** are scoped to the specific node URLs, WalletConnect relay domains, and the UluMCP enVoi endpoint. No `<all_urls>`. Content scripts run on `https://*/*` at `document_start` — necessary for universal `window.algorand` provider injection.

---

## Ecosystem

### UluMCP — enVoi Name Resolution

[UluMCP](https://github.com/MaidToShelly/algovou) is the x402-gated MCP server that powers `.voi` name resolution in the Send modal. When you type `shelly.voi` and click **Resolve**, the extension:

1. Opens an MCP session with `mcp.ilovechicken.co.uk/mcp`
2. Calls the `envoi_resolve_address` tool
3. Receives a 402 — pays ~1 VOI on-chain (within your spending cap)
4. Retries with the signed `PAYMENT-SIGNATURE` header
5. Receives the resolved Voi address from the [enVoi](https://envoi.sh) registry

The resolved address is always validated with `algosdk.isValidAddress` before display. A server-attribution warning is shown below the confirmed address.

---

## Security

See [SECURITY_AUDIT.md](./SECURITY_AUDIT.md) for a full audit report covering all source files, manifest permissions, bundle analysis, and the enVoi integration trust model.

**Summary (March 2026 independent adversarial review):**
- 0 Critical · 0 High · 1 Medium open (migration ghost — no funds at risk)
- Vault encrypted with PBKDF2 (600k iterations) → AES-GCM 256-bit
- No `eval()` in the production bundle (vm polyfill excluded)
- Strict CSP: `script-src 'self'; object-src 'none';`
- Genesis hash verified on every chain switch
- Chrome Web Store submission requires 3 additional steps (see SECURITY_AUDIT.md)

---

## License

MIT — see [LICENSE](./LICENSE)
