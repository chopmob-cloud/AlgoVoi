# AlgoVoi

A Manifest V3 Chrome extension — Web3 wallet for **Algorand** and **Voi** networks with built-in payment protocol support for x402, MPP, and AP2.

![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-blue?logo=googlechrome)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react)
![Version](https://img.shields.io/badge/version-0.9.0-brightgreen)

---

## Features

- **Multi-chain wallet** — Algorand mainnet and Voi mainnet from a single extension
- **DEX token swaps** — Swap any Algorand ASA via Haystack Router (best-route aggregation across all Algorand DEXes); swap Voi tokens via Snowball aggregator (direct pool swaps with slippage protection)
- **ARC-0027 provider** — `window.algorand` injected into every page, compatible with Pera, Defly, and Lute dApps
- **WalletConnect v2** — Pair with any WalletConnect-compatible mobile wallet (Pera, Defly, Voi Wallet)
- **x402 micropayments** — Automatic HTTP 402 payment handling; pay for API calls and content without leaving the page
- **MPP payments** — Machine Payments Protocol (`WWW-Authenticate: Payment`) support using AVM on-chain transactions
- **AP2 credentials** — Google Agent Payments Protocol; sign verifiable payment mandates for AI agent commerce
- **AI agent wallet** — WalletConnect Web3Wallet mode lets AI agents connect to AlgoVoi and request transaction signing without ever touching private keys
- **SpendingCapVault** — Deploy an AVM smart contract that enforces per-transaction and daily spending caps for autonomous agent payments; supports ALGO, VOI, USDC, aUSDC and any ASA via `pay_asa()` + `opt_in_asa()`; owner actions (suspend, resume, withdraw, update limits) via mnemonic or WalletConnect
- **30-day local signing key** — Import your mnemonic with a 30-day TTL for reliable local signing; eliminates WalletConnect relay dependency for all operations; auto-expires and prompts re-import
- **Anti-phishing** — Clipboard hijacking detection (warns if pasted address was swapped by malware), homograph domain detection (flags Unicode lookalike domains like Cyrillic 'а'), transaction simulation via algod `/v2/transactions/simulate`, dangerous transaction field warnings (rekeyTo, closeRemainderTo, clawback, etc.)
- **Falcon PQC signatures** — Post-quantum Falcon-1024 accounts on Algorand mainnet; WASM build (88KB) of the exact same C Falcon library as the AVM v12 `falcon_verify` opcode; deterministic signing, logic sig addresses, encrypted key storage; quantum-resistant today
- **Encrypted vault** — PBKDF2 (600k iterations) + AES-GCM-256; your keys never leave your device unencrypted
- **WC chromeStorage adapter** — WalletConnect sessions persist in `chrome.storage.local` via a custom `IKeyValueStorage` adapter; survives lock/unlock cycles, SW suspension, and browser restarts
- **enVoi name resolution** — Send to `.voi` names via UluMCP (x402-gated, 1 VOI per lookup)
- **DevTools panel** — Inspect transactions, x402 flows, and Bazaar listings from Chrome DevTools
- **AI Agent Chat (both chains)** — Ask questions about tokens, NFTs, swaps, lending, and names in natural language (Agents tab); structured commands (swap, send, balance, resolve, register, price) execute directly via MCP tools at zero AI cost; conversational queries fall back to Claude Sonnet 4 via the UluMCP server — API key stays server-side
  - **Voi**: HumbleSwap/Snowball DEX, enVoi (.voi) names, ARC-200 tokens, ARC-72 NFTs, DorkFi lending
  - **Algorand**: Haystack Router DEX (Tinyman/Pact/Folks aggregator), NFD (.algo) names, Pera asset verification
- **Coinbase Onramp** — Buy ALGO directly from the wallet via a secure session-token flow; wallet address is sent via POST body to the AlgoVoi backend which fetches a one-time Coinbase session token — addresses are never exposed in URL parameters (feature-flagged; pending Coinbase UK approval)
- **Auto-update notifications** — Extension checks for new releases via the MCP server on startup + daily; amber badge + banner when a newer version is available; server-side `/version` endpoint auto-syncs from GitHub releases every 30 minutes

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
├── background/     Service worker: wallet store, chain clients, x402/MPP/AP2/Web3Wallet/swap/agent-chat/onramp handlers, message router
├── content/        Content script: bridges inpage ↔ background messages
├── inpage/         Injected into pages: window.algorand provider + fetch x402/MPP intercept
├── popup/          React wallet UI (360 × 600 px) — includes Agent Sessions, AI Chat + Swap tabs
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
**Status: 0 Critical · 0 High · 0 Medium · 0 Low open** (Hardening I–XX complete, Comet CDP independently validated).

Recent hardening highlights:
- **XVIII** — `executeSend` address validation (MCP-resolved addresses validated via `algosdk.isValidAddress` before signing)
- **XIX** — Side panel keep-alive security (content script port guard, SW suspension watchdog alarm)
- **XX** — `executeResolve` display validation (MCP-returned addresses validated before display)

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

1. Open AlgoVoi popup → **Agents** tab → **Connect AI Agent**
2. Copy the WC pairing URI and pass it to your agent
3. Agent connects using WalletConnect Sign Client (`@walletconnect/sign-client`)
4. Session is auto-approved — agent gets access to both Algorand + Voi accounts
5. Agent sends `algo_signTxn` requests → AlgoVoi shows an approval popup with transaction details
6. User approves → AlgoVoi signs with the vault key → signed transaction returned to agent

Both **Algorand mainnet** and **Voi mainnet** are available in the same agent session using CAIP-2 namespaces.

> **MCP Relay Bridge:** Chrome MV3 service workers cannot receive WalletConnect relay WebSocket push notifications. AlgoVoi works around this by routing relay messages through the MCP server (`mcp.ilovechicken.co.uk/wc-bridge`) as an HTTP polling bridge. The agent must re-encrypt and POST its session proposal to the bridge; the extension polls every 2 seconds. See `C:\algo\aiagent\agent-auto.mjs` for a working example.

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

## Falcon PQC (Post-Quantum Signatures)

AlgoVoi supports **Falcon-1024** post-quantum accounts on Algorand mainnet — quantum-resistant signing using the same C Falcon library as Algorand's AVM v12 `falcon_verify` opcode, compiled to 88KB WASM via Emscripten.

1. **+ Add** → **Falcon PQC Account** (Algorand chain only)
2. Fund the new address with ALGO (it's a logic sig address, needs MBR + fees)
3. Transactions are signed with deterministic Falcon and submitted as 4-txn groups (1 real + 3 dummy for logic sig byte budget pooling)

| Property | Value |
|----------|-------|
| Public key | 1,793 bytes |
| Private key | 2,305 bytes (encrypted in vault) |
| Signature | ~1,230 bytes (deterministic compressed) |
| WASM size | 88 KB |
| AVM version | 12 (`falcon_verify` opcode) |
| Security level | NIST Level 5 (AES-256 equivalent) |

> **No mnemonic backup** — Falcon keys are raw bytes stored encrypted in the vault. Use key export for backup. Voi support will be added when Voi upgrades to AVM 12+.

---

## AI Agent Chat

Available on **both chains** in the **Agents** tab. Ask questions or issue commands in plain English — AlgoVoi decides the fastest path:

| Input type | Path | AI cost |
|---|---|---|
| Structured command (`swap 10 VOI for USDC`, `send 1 ALGO to grampantics.algo`, `price of VIA`) | Direct → MCP tool | Zero |
| Conversational / ambiguous (`what are the best liquidity pools?`) | AI → Claude Sonnet 4 + tool whitelist | Per response |

**Voi categories:** tokens · nfts · swaps · names · lending · general
**Algorand categories:** tokens · swaps · names · general

63 MCP tools across 15 modules. The Anthropic API key lives exclusively on the UluMCP server — it is never bundled in the extension. Tool calls are whitelisted per category; blocked attempts are logged server-side. `agent_chat` requires dual authentication (chrome-extension:// origin + API key).

### Voi Chain Tools (39 tools)

| Module | Tools | Description |
|--------|-------|-------------|
| **arc200** (6) | `arc200_list_tokens`, `arc200_balance_of`, `arc200_transfers`, `arc200_holders`, `arc200_allowance`, `arc200_approvals` | ARC-200 token queries — list, balances, transfers, holders |
| **arc200 txns** (2) | `arc200_transfer_txn`, `arc200_approve_txn` | Build unsigned ARC-200 transfer/approve transactions |
| **arc72** (3) | `arc72_tokens`, `arc72_collections`, `arc72_transfers` | ARC-72 NFT queries — tokens, collections, transfer history |
| **arc72 txns** (1) | `arc72_transferFrom_txn` | Build unsigned NFT transfer transaction |
| **envoi** (4) | `envoi_resolve_name`, `envoi_resolve_address`, `envoi_resolve_token`, `envoi_search` | enVoi .voi name resolution and search |
| **envoi txns** (1) | `envoi_purchase_txn` | Build unsigned .voi name registration transaction |
| **humble** (10) | `humble_protocol_stats`, `humble_pools`, `humble_pool_details`, `humble_pool_analytics`, `humble_pool_state`, `humble_quote`, `humble_tokens`, `humble_token_metadata`, `humble_token_price`, `humble_price_history` | HumbleSwap DEX — pools, quotes, token prices, analytics |
| **humble txns** (2) | `humble_swap_txn`, `humble_router` | Build unsigned swap transactions, route via HumbleSwap |
| **humble advanced** (1) | `humble_arbitrage` | Arbitrage opportunity detection across pools |
| **snowball** (4) | `snowball_quote`, `snowball_pool`, `snowball_pools`, `snowball_tokens` | Snowball aggregator — quotes, pools, token list |
| **swap200** (2) | `swap200_pool_state`, `swap200_quote` | Direct pool state and swap quotes |
| **marketplace** (3) | `mp_listings`, `mp_sales`, `mp_deletes` | NFT marketplace — active listings, sales history |
| **dorkfi** (7) | `dorkfi_markets`, `dorkfi_market_data`, `dorkfi_market_detail`, `dorkfi_pool_state`, `dorkfi_user_health`, `dorkfi_user_positions`, `dorkfi_liquidatable_users` | DorkFi lending — markets, positions, health factors, liquidations |

### Algorand Chain Tools (12 tools)

| Module | Tools | Description |
|--------|-------|-------------|
| **nfd** (6) | `nfd_get`, `nfd_lookup_address`, `nfd_search`, `nfd_browse`, `nfd_activity`, `nfd_analytics` | NFDomains (.algo) — name resolution, reverse lookup, browse, search, activity, sales analytics |
| **haystack** (3) | `haystack_quote`, `haystack_swap_txn`, `haystack_needs_optin` | Haystack Router DEX aggregator (Tinyman, Pact, Folks) — best-route quotes, unsigned swap txns, opt-in checks |
| **pera** (3) | `pera_asset_verification`, `pera_asset_details`, `pera_asset_search` | Pera Wallet asset data — verification status (verified/trusted/suspicious), asset details, search |

### Shared Tools (12 tools, both chains)

| Module | Tools | Description |
|--------|-------|-------------|
| **txns** (7) | `payment_txn`, `arc200_transfer_txn`, `arc200_approve_txn`, `arc72_transferFrom_txn`, `envoi_purchase_txn`, `aramid_bridge_txn` + 1 more | Transaction builders — payment, token transfer, NFT transfer, bridge |
| **algod** (1) | `algod_send_raw_transactions` | Submit signed transactions to the network |
| **chat** (1) | `agent_chat` | AI assistant — Claude Sonnet 4 with per-category tool whitelist |
| **x402** (2) | `x402_check`, `x402_pay_to` | x402 payment protocol — check requirements, execute payment |

```
User types "swap 10 VOI for USDC" (Voi chain)
  → direct-actions: parseDirectAction() matches SWAP_RE
  → calls humble_pools + humble_swap_txn via MCP (zero AI tokens)
  → returns unsigned txn → user approves in existing signing flow

User types "send 1 ALGO to grampantics.algo" (Algorand chain)
  → direct-actions: matches SEND_RE → nfd_get resolves .algo name
  → calls payment_txn via MCP → returns unsigned txn → user approves

User types "what tokens have the most liquidity?"
  → no direct-action match → agent_chat (Claude Sonnet 4)
  → server calls allowed tools → returns natural-language reply
```

---

## Coinbase Onramp

Buy ALGO directly from the wallet via the **Buy** button in the Assets tab (Algorand chain).

**Security flow:**
1. Extension POSTs the wallet address + asset to `mcp.ilovechicken.co.uk/api/coinbase-session`
2. Backend verifies the request and fetches a one-time session token from Coinbase
3. Extension opens `pay.coinbase.com?sessionToken=...` — wallet address is never in the URL

This satisfies Coinbase's "require secure initialization" setting. The feature is controlled by the `COINBASE_ONRAMP_ENABLED` constant and is pending Coinbase UK country approval.

---



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
