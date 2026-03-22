# AlgoVoi

A Manifest V3 Chrome extension — Web3 wallet for **Algorand** and **Voi** networks with built-in payment protocol support for x402, MPP, and AP2.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)
![Version](https://img.shields.io/badge/version-0.4.0-brightgreen)

---

## Features

- **Multi-chain wallet** — Algorand mainnet and Voi mainnet from a single extension
- **DEX token swaps** — Swap any Algorand ASA via Haystack Router (best-route aggregation across all Algorand DEXes, ALGO→USDC→USDt and beyond); mnemonic and WalletConnect paths both supported
- **ARC-0027 provider** — `window.algorand` injected into every page, compatible with Pera, Defly, and Lute dApps
- **WalletConnect v2** — Pair with any WalletConnect-compatible mobile wallet (Pera, Defly, Voi Wallet)
- **x402 micropayments** — Automatic HTTP 402 payment handling; pay for API calls and content without leaving the page
- **MPP payments** — Machine Payments Protocol (`WWW-Authenticate: Payment`) support using AVM on-chain transactions
- **AP2 credentials** — Google Agent Payments Protocol; sign verifiable payment mandates for AI agent commerce
- **AI agent wallet** — WalletConnect Web3Wallet mode lets AI agents connect to AlgoVoi and request transaction signing without ever touching private keys
- **SpendingCapVault** — Deploy an AVM smart contract that enforces per-transaction and daily spending caps for autonomous agent payments; supports ALGO, VOI, USDC, aUSDC and any ASA via `pay_asa()` + `opt_in_asa()`; owner actions (suspend, resume, withdraw, update limits) via mnemonic or WalletConnect
- **30-day local signing key** — Import your mnemonic with a 30-day TTL for reliable local signing; eliminates WalletConnect relay dependency for all operations; auto-expires and prompts re-import
- **Encrypted vault** — PBKDF2 (600k iterations) + AES-GCM-256; your keys never leave your device unencrypted
- **WC chromeStorage adapter** — WalletConnect sessions persist in `chrome.storage.local` via a custom `IKeyValueStorage` adapter; survives lock/unlock cycles, SW suspension, and browser restarts
- **enVoi name resolution** — Send to `.voi` names via UluMCP (x402-gated, 1 VOI per lookup)
- **DevTools panel** — Inspect transactions, x402 flows, and Bazaar listings from Chrome DevTools

---

## Payment Protocols

AlgoVoi supports three HTTP payment protocols, all detected automatically:

| Protocol | Header | Auth Response | Use case |
|---|---|---|---|
| **x402** | `PAYMENT-REQUIRED` | `PAYMENT-SIGNATURE` | Content paywalls, API metering |
| **MPP** | `WWW-Authenticate: Payment` | `Authorization: Payment <credential>` | Machine-to-machine HTTP auth |
| **AP2** | via `window.algorand.ap2` | `PaymentMandate` (VDC) | AI agent commerce (Google AP2) |

MPP is checked first; x402 second. Both submit real AVM on-chain transactions. AP2 signs a verifiable credential only — the merchant handles settlement.

---

## Architecture

```
src/
├── background/     Service worker: wallet store, chain clients, x402/MPP/AP2/Web3Wallet/swap handlers, message router
├── content/        Content script: bridges inpage ↔ background messages
├── inpage/         Injected into pages: window.algorand provider + fetch x402/MPP intercept
├── popup/          React wallet UI (360 × 600 px) — includes Agent Sessions + Swap tabs
├── approval/       Payment approval popup (x402, MPP, AP2, agent sign requests)
├── devtools/       Chrome DevTools panel (TxnInspector, X402Inspector, BazaarPanel)
└── shared/         Types, constants, crypto utils, ASA metadata cache, debug logger
```

**Message flow:**
```
Page (dApp / AI agent)
  └─ window.postMessage ──► content script
                               └─ chrome.runtime.sendMessage ──► background service worker
                                                                      └─ algosdk / WC SDK / Web3Wallet
```

**x402 flow:**
```
fetch() → 402 + PAYMENT-REQUIRED header → inpage intercepts → approval popup → user approves
  → background signs + submits AVM txn → retry fetch with PAYMENT-SIGNATURE header
```

**MPP flow:**
```
fetch() → 402 + WWW-Authenticate: Payment → inpage intercepts → approval popup → user approves
  → background builds/signs/submits AVM txn → retry fetch with Authorization: Payment <credential>
```

**AP2 flow:**
```
window.algorand.ap2.requestPayment(cartMandate) → approval popup → user approves
  → background SHA-256 hashes CartMandate + signs PaymentMandate with ed25519
  → returns PaymentMandate (no AVM txn submitted — merchant settles separately)
```

**Agent (Web3Wallet) flow:**
```
AI agent pairs via WC URI → AlgoVoi acts as WC wallet → agent sends algo_signTxn request
  → approval popup → user approves → AlgoVoi signs with vault key → signed txn returned to agent
  (agent never touches private keys)
```

---

## Supported Networks

| Network | Node | Genesis ID | CAIP-2 |
|---------|------|------------|--------|
| Algorand Mainnet | `mainnet-api.algonode.cloud` | `mainnet-v1.0` | `algorand:mainnet-v1.0` |
| Voi Mainnet | `mainnet-api.voi.nodely.dev` | `voimain-v1.0` | `algorand:r20fSQI8gWe_kFZziNonSPCXLwcQmH_n` |

Both chains share the same ed25519 key pair and are available in a single WC agent session.

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- A WalletConnect Project ID from [cloud.walletconnect.com](https://cloud.walletconnect.com)

### Setup

```bash
git clone https://github.com/chopmob-cloud/AlgoVoi.git
cd AlgoVoi
npm install
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
VITE_WC_PROJECT_ID=your_walletconnect_project_id
VITE_WC_APP_URL=https://your-public-url.com
VITE_HAYSTACK_ROUTER_API_KEY=your_haystack_api_key   # required for DEX swaps — get one at txnlab.dev
VITE_HAYSTACK_REFERRER_ADDRESS=                       # optional: your Algorand address for referral fees
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
**Status: 0 Critical · 0 High · 0 Medium · 0 Low open** (Hardening I–XIV complete, Comet CDP independently validated v0.4.0).

### 30-day local signing key

For reliable signing without WalletConnect relay dependency:

1. Click **+ Add** → **Import Mnemonic** in the extension
2. Enter your 25-word seed (same one from Defly/Pera)
3. Key is stored AES-GCM-256 encrypted with a 30-day TTL
4. All operations (x402, MPP, swaps, sends) sign locally — no phone needed
5. After 30 days the key auto-wipes; re-import to refresh

This is stricter than MetaMask/Phantom (which store keys with no TTL). Comet CDP validated the security model.

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

AlgoVoi intercepts `fetch()` calls that return HTTP 402 + `PAYMENT-REQUIRED` header and handles payment automatically:

```typescript
// This fetch will trigger a payment approval popup if the server returns 402
const response = await fetch("https://api.example.com/premium-data");
const data = await response.json(); // resolves after payment is approved
```

Supported payment assets:
- **ALGO** (native)
- **USDC** (ASA 31566704 on Algorand)
- **VOI** (native)
- **aUSDC** (ASA 302190 on Voi)

---

## MPP Payments

AlgoVoi handles [Machine Payments Protocol](https://mpp.dev) (`WWW-Authenticate: Payment`) responses automatically using the custom `avm` method:

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: Payment id="...", realm="api.example.com", method="avm",
  intent="charge", request="<base64url-MppAvmRequest>"
```

The extension builds and submits an AVM on-chain transaction, then retries the original request with:
```
Authorization: Payment <base64url-MppCredential>
```

---

## AP2 — Agent Payments Protocol

AlgoVoi supports [Google's AP2 protocol](https://github.com/google-agentic-commerce/AP2) via `window.algorand.ap2`:

```typescript
// Request a signed PaymentMandate for a CartMandate from the merchant
const paymentMandate = await window.algorand.ap2.requestPayment(cartMandate);

// List stored IntentMandates (spending authorizations)
const mandates = await window.algorand.ap2.getIntentMandates();
```

The wallet:
1. Verifies the CartMandate structure and expiry
2. Shows an approval popup with items, total, and merchant details
3. SHA-256 hashes the CartMandate and signs a `PaymentMandate` with the user's ed25519 key
4. Returns the signed credential — **no AVM transaction is submitted**; the merchant settles externally

---

## AI Agent Wallet (Web3Wallet)

AI agents can connect to AlgoVoi as their wallet via WalletConnect — they never touch private keys:

1. Open AlgoVoi popup → **Agents** tab → **Connect Agent**
2. Share the WC pairing URI with your agent (or scan the QR code)
3. Agent connects using any WC-compatible SDK (`viem`, `algosdk`, ADK, etc.)
4. Agent sends `algo_signTxn` requests — AlgoVoi shows an approval popup for each one
5. User approves → AlgoVoi signs with the vault key → signed transaction returned to agent

Both **Algorand mainnet** and **Voi mainnet** are available in the same agent session using CAIP-2 namespaces.

```typescript
// Example: agent using WalletConnect to request a transaction signature
const result = await signClient.request({
  topic: session.topic,
  chainId: "algorand:mainnet-v1.0",   // or "algorand:r20fSQI8gWe_kFZziNonSPCXLwcQmH_n" for Voi
  request: {
    method: "algo_signTxn",
    params: [[{ txn: base64MsgpackUnsignedTxn }]],
  },
});
```

---

## Ecosystem

### Compatible Services

| Project | Protocol | Description |
|---------|---------|-------------|
| [UluMCP](https://github.com/MaidToShelly/UluMCP) | x402 | MCP server for AI agents — tokens, NFTs, DEX swaps, marketplace. x402 + WAD metered billing |
| [x402 test site](https://x402.ilovechicken.co.uk) | x402 | Live demo — browse gated content with AlgoVoi paying automatically |

### Live Endpoints

#### x402 Test Endpoints

Public endpoints for testing x402 clients against real on-chain payments:

| Endpoint | Network | Asset | Price |
|----------|---------|-------|-------|
| `GET https://api.ilovechicken.co.uk/api/premium` | Algorand mainnet | USDC (ASA 31566704) | 0.01 USDC |
| `GET https://api.ilovechicken.co.uk/api/voi-premium` | Voi mainnet | aUSDC (ASA 302190) | 0.01 aUSDC |
| `GET https://api.ilovechicken.co.uk/api/config` | — | — | Public (no payment) |

#### MPP Test Endpoints

Live endpoints using `WWW-Authenticate: Payment` with the `avm` method — full MPP flow (challenge → AVM on-chain txn → `Authorization: Payment` credential):

| Endpoint | Network | Asset | Price |
|----------|---------|-------|-------|
| `GET https://api.ilovechicken.co.uk/api/mpp-premium` | Algorand mainnet | ALGO (native) | configurable via `MPP_AMOUNT` env (µALGO) |
| `GET https://api.ilovechicken.co.uk/api/mpp-voi-premium` | Voi mainnet | VOI (native) | configurable via `MPP_VOI_AMOUNT` env (µVOI) |

#### AP2 Test Endpoint

Live endpoint for the Google AP2 credential flow — no AVM transaction submitted; the wallet signs a `PaymentMandate` with its ed25519 key, the server verifies the signature + replay protection:

| Endpoint | Network | Asset | Price |
|----------|---------|-------|-------|
| `POST https://api.ilovechicken.co.uk/api/ap2-premium` | Algorand / Voi | USD (off-chain) | set by merchant CartMandate |

#### MCP Gateway (x402 + MPP)

AI agent tools gated by x402 or MPP, priced in native ALGO:

| Endpoint | Protocol | Asset | Price | Description |
|----------|----------|-------|-------|-------------|
| `POST https://mcp.ilovechicken.co.uk/mcp` | x402 | VOI (native) | 1 VOI | MCP session init + tool calls (enVoi name resolution, chain tools) |
| `GET https://mcp.ilovechicken.co.uk/account/:address` | MPP | ALGO (native) | 0.001 ALGO | Account balance and state |
| `GET https://mcp.ilovechicken.co.uk/assets/:id` | MPP | ALGO (native) | 0.001 ALGO | ASA metadata and supply |
| `GET https://mcp.ilovechicken.co.uk/transactions/:address` | MPP | ALGO (native) | 0.002 ALGO | Transaction history for an address |

#### Platform Gateway (server-to-server)

For tenant integrations — server-side x402 challenge/verify flow:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `https://api.ilovechicken.co.uk/challenge` | `POST` | Issue a payment challenge (returns `challengeId` + payment requirements) |
| `https://api.ilovechicken.co.uk/verify` | `POST` | Verify a submitted on-chain payment against a challenge |
| `https://api.ilovechicken.co.uk/health` | `GET` | Gateway health check |

---

## Development

```bash
# Type check
npm run type-check

# Run tests
npm test

# Build with sourcemaps (development)
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
