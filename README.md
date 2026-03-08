# AlgoVoi

A Manifest V3 Chrome extension — Web3 wallet for **Algorand** and **Voi** networks with built-in [x402](https://x402.org) HTTP micropayment support.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)

---

## Features

- **Multi-chain wallet** — Algorand mainnet and Voi mainnet from a single extension
- **ARC-0027 provider** — `window.algorand` injected into every page, compatible with Pera, Defly, and Lute dApps
- **WalletConnect v2** — Pair with any WalletConnect-compatible mobile wallet
- **x402 micropayments** — Automatic HTTP 402 payment handling; pay for API calls and content without leaving the page
- **Encrypted vault** — PBKDF2 (600k iterations) + AES-GCM-256; your keys never leave your device unencrypted
- **DevTools panel** — Inspect transactions, x402 flows, and Bazaar listings from Chrome DevTools

---

## Architecture

```
src/
├── background/     Service worker: wallet store, chain clients, x402 handler, message router
├── content/        Content script: bridges inpage ↔ background messages
├── inpage/         Injected into pages: window.algorand provider + fetch x402 intercept
├── popup/          React wallet UI (360 × 600 px)
├── approval/       x402 payment approval popup
├── devtools/       Chrome DevTools panel (TxnInspector, X402Inspector, BazaarPanel)
└── shared/         Types, constants, crypto utils, debug logger
```

**Message flow:**
```
Page (dApp)
  └─ window.postMessage ──► content script
                               └─ chrome.runtime.sendMessage ──► background service worker
                                                                      └─ algosdk / WC SDK
```

**x402 flow:**
```
fetch() → 402 response → inpage intercepts → approval popup → user approves
  → background signs + submits txn → retry fetch with X-PAYMENT header
```

---

## Supported Networks

| Network | Node | Genesis ID |
|---------|------|------------|
| Algorand Mainnet | `mainnet-api.algonode.cloud` | `mainnet-v1.0` |
| Voi Mainnet | `mainnet-api.voi.nodely.dev` | `voimain-v1.0` |

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- A WalletConnect Project ID from [cloud.walletconnect.com](https://cloud.walletconnect.com)

### Setup

```bash
git clone https://github.com/MaidToShelly/algovou.git
cd algovou
npm install
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
VITE_WC_PROJECT_ID=your_walletconnect_project_id
VITE_WC_APP_URL=https://your-public-url.com
```

### Build

```bash
# Production build
npm run build

# Development build with watch
npm run dev
```

The extension is built to `dist/`.

### Load in Chrome

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` folder

---

## Security

The vault uses a session-key pattern:

1. On **unlock** — PBKDF2 derives a `CryptoKey` from the user's password (never stored)
2. The `CryptoKey` is held in service-worker memory only
3. All vault reads/writes use AES-GCM-256 with a fresh random IV per write
4. On **lock** or service-worker suspension — the key is wiped from memory

See [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md) for the full security audit report.
**Status: 0 Critical · 0 High · 0 Medium · 0 Low open** (Hardening I–VII complete).

---

## ARC-0027 Provider API

AlgoVoi injects `window.algorand` into every page:

```typescript
// Connect and get accounts
const { accounts } = await window.algorand.enable({ genesisID: "mainnet-v1.0" });

// Sign transactions
const signedTxns = await window.algorand.signTransactions([txnBase64]);

// Sign arbitrary bytes
const { sig } = await window.algorand.signBytes({ data: new Uint8Array([...]) });
```

---

## x402 Automatic Payments

AlgoVoi intercepts `fetch()` calls that return HTTP 402 and handles payment automatically:

```typescript
// This fetch will trigger a payment approval popup if the server returns 402
const response = await fetch("https://api.example.com/premium-data");
const data = await response.json(); // resolves after payment is approved
```

Supported payment assets:
- **ALGO** (native)
- **USDC** (ASA 31566704 on Algorand)
- **aUSDC** (ASA 302190 on Voi)

---

## Ecosystem

### Compatible x402 Services

| Project | Network | Description |
|---------|---------|-------------|
| [UluMCP](https://github.com/MaidToShelly/UluMCP) | Algorand + **Voi** | MCP server for AI agents — tokens, NFTs, DEX swaps, marketplace. Supports x402 payment gating and WAD metered billing |
| [x402 test site](https://x402.ilovechicken.co.uk) | Algorand + **Voi** | Live demo — browse gated content with AlgoVoi paying automatically |

UluMCP is a working example of x402 on Voi — deploy it with `X402_AVM_PAY_TO` and `X402_AVM_PRICE` set and AlgoVoi will automatically handle the 402 payment flow when an AI agent hits a gated tool endpoint.

The AlgoVoi **Bazaar DevTools panel** is designed to surface marketplace listings from services like UluMCP (`mp_listings`, `mp_sales`).

---

## Development

```bash
# Type check
npm run typecheck

# Lint
npm run lint

# Build for development (with sourcemaps)
NODE_ENV=development npm run build
```

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Commit your changes
4. Open a pull request

Please review [`SECURITY_AUDIT.md`](./SECURITY_AUDIT.md) before contributing changes to the vault, signing, or payment handling code.

---

## License

MIT
