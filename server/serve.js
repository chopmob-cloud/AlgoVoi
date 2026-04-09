import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { handleCoinbaseSession } from "./lib/coinbase-session.js";
import { startListener, getMessages, pushMessage, stopListener } from "./lib/wc-bridge.js";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerArc200Tools } from "./tools/arc200.js";
import { registerArc72Tools } from "./tools/arc72.js";
import { registerSwapTools } from "./tools/swap200.js";
import { registerMarketplaceTools } from "./tools/marketplace.js";
import { registerSnowballTools } from "./tools/snowball.js";
import { registerEnvoiTools } from "./tools/envoi.js";
import { registerHumbleApiTools } from "./tools/humble.js";
import { registerTxnTools } from "./tools/txns.js";
import { registerX402Tools } from "./tools/x402.js";
import { registerAlgodTools } from "./tools/algod.js";
import { registerChatTool } from "./tools/chat.js";
import { registerDorkFiTools } from "./tools/dorkfi.js";
import { registerNfdTools } from "./tools/nfd.js";
import { registerHaystackTools } from "./tools/haystack.js";
import { registerPeraTools } from "./tools/pera.js";
import { registerAllbridgeTools } from "./tools/allbridge.js";
import {
  buildPaymentRequirements,
  hasPaymentHeader,
  getPaymentPayload,
} from "./lib/x402.js";

// ── Version check endpoint ──────────────────────────────────────────────────
// Reads version.json on disk (cached, re-reads on mtime change).
// Update version.json to publish a new version notification to all extensions.

const __dirname = dirname(fileURLToPath(import.meta.url));
let _versionCache = null;
let _versionMtime = 0;

function getVersionInfo() {
  const versionFile = join(__dirname, "version.json");
  try {
    const stat = statSync(versionFile);
    if (!_versionCache || stat.mtimeMs !== _versionMtime) {
      _versionCache = JSON.parse(readFileSync(versionFile, "utf-8"));
      _versionMtime = stat.mtimeMs;
    }
    return _versionCache;
  } catch {
    return { latest: "0.0.0", url: "", notes: "" };
  }
}


// ── Standalone tool handlers for /voi-swap HTTP endpoint (built at module load) ──
const _voiSwapHandlers = new Map();
{
  const fakeSrv = { tool: (name, _desc, _schema, handler) => _voiSwapHandlers.set(name, handler) };
  registerTxnTools(fakeSrv);
}
async function callVoiSwapFn(toolName, args) {
  const handler = _voiSwapHandlers.get(toolName);
  if (!handler) throw new Error('Unknown tool: ' + toolName);
  const result = await handler(args);
  const text = result?.content?.find((c) => c.type === 'text')?.text;
  return text ? JSON.parse(text) : result;
}

function createMcpServer() {
  const server = new McpServer({
    name: "ulu-mcp",
    version: "0.0.1",
  });

  // Intercept tool registrations to build callable handler map
  const toolHandlers = new Map();
  const origTool = server.tool.bind(server);
  server.tool = function(name, desc, schema, handler) {
    toolHandlers.set(name, handler);
    return origTool(name, desc, schema, handler);
  };

  registerArc200Tools(server);
  registerArc72Tools(server);
  registerSwapTools(server);
  registerMarketplaceTools(server);
  registerSnowballTools(server);
  registerEnvoiTools(server);
  registerHumbleApiTools(server);
  registerTxnTools(server);
  registerX402Tools(server);
  registerAlgodTools(server);
  registerDorkFiTools(server);
  registerNfdTools(server);
  registerHaystackTools(server);
  registerPeraTools(server);
  registerAllbridgeTools(server);

  // Restore and register chat tool
  server.tool = origTool;
  const port = parseInt(process.env.MCP_PORT || "3000", 10);
  async function callToolFn(toolName, args) {
    const handler = toolHandlers.get(toolName);
    if (!handler) throw new Error("Unknown tool: " + toolName);
    const result = await handler(args);
    const text = result?.content?.find((c) => c.type === "text")?.text;
    return text || JSON.stringify(result);
  }
  registerChatTool(server, callToolFn, port);

  return server;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function isInitMessage(body) {
  if (Array.isArray(body)) return body.some(isInitializeRequest);
  return isInitializeRequest(body);
}

function requiresPayment() {
  const accepts = buildPaymentRequirements();
  return accepts.length > 0;
}

function sendPaymentRequired(res) {
  const accepts = buildPaymentRequirements();
  const payload = {
    x402Version: 2,
    error: "Payment Required",
    accepts,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  res.writeHead(402, {
    "Content-Type": "application/json",
    "PAYMENT-REQUIRED": encoded,
  });
  res.end(JSON.stringify(payload));
}

const transports = {};

async function handlePost(req, res, body) {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && transports[sessionId]) {
    const toolName = body?.method === "tools/call" ? body?.params?.name : null;
    const isAgentChat = toolName === "agent_chat";
    // Restrict agent_chat to AlgoVoi extension only — origin + API key
    if (isAgentChat) {
      const chatOrigin = req.headers.origin || "";
      const chatApiKey = req.headers["x-algovoi-key"] || "";
      const ALGOVOI_API_KEY = process.env.ALGOVOI_API_KEY || "55318ce48a353fe5d9a01bd85c4c4c52dd73d2197512f42c1ad41b443de4ca85";
      if (!/^chrome-extension:\/\/[a-z]{32}$/.test(chatOrigin) || chatApiKey !== ALGOVOI_API_KEY) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "agent_chat requires valid AlgoVoi extension credentials" }, id: body?.id ?? null }));
        return;
      }
    }
    const isExemptTool = ["snowball_tokens", "humble_pools", "humble_swap_txn", "humble_quote", "humble_tokens", "humble_token_metadata", "humble_token_price", "humble_price_history", "humble_router", "humble_arbitrage", "envoi_resolve_name", "envoi_resolve_address", "envoi_resolve_token", "envoi_search", "arc200_tokens", "arc200_token_metadata", "arc200_balance", "arc200_holders", "arc200_transfers", "arc200_approve_txn", "arc200_transferFrom_txn", "payment_txn", "envoi_purchase_txn", "aramid_bridge_txn", "dorkfi_markets", "dorkfi_market_data", "dorkfi_market_detail", "dorkfi_pool_state", "dorkfi_user_health", "dorkfi_user_positions", "dorkfi_liquidatable_users", "snowball_quote", "snowball_pool", "snowball_pools", "arc72_tokens", "arc72_transfers", "arc72_collection", "marketplace_listings", "marketplace_sales", "marketplace_collection_stats", "swap200_pool_state", "swap200_quote", "nfd_get", "nfd_lookup_address", "nfd_search", "nfd_browse", "nfd_activity", "nfd_analytics", "haystack_quote", "haystack_swap_txn", "haystack_needs_optin", "pera_asset_verification", "pera_asset_details", "pera_asset_search","allbridge_get_tokens","allbridge_bridge_txn","allbridge_transfer_status"].includes(toolName);
    if (requiresPayment() && !isInitMessage(body) && !hasPaymentHeader(req) && !isAgentChat && !isExemptTool) {
      sendPaymentRequired(res);
      return;
    }
    await transports[sessionId].handleRequest(req, res, body);
    return;
  }

  if (!sessionId && isInitMessage(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && transports[sid]) delete transports[sid];
    };
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID" },
      id: null,
    })
  );
}

async function handleGet(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.writeHead(400);
    res.end("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

async function handleDelete(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    res.writeHead(400);
    res.end("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
}

const PORT = parseInt(process.env.MCP_PORT || "3000", 10);

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // ── Version check (public, no auth) ──
  if (url.pathname === "/version" && req.method === "GET") {
    const info = getVersionInfo();
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    });
    res.end(JSON.stringify(info));
    return;
  }

  // ── Voi Native Swap — builds unsigned HumbleSwap txns for extension signing ──
  if (url.pathname === '/voi-swap') {
    const origin = req.headers.origin || '';
    const isExtOrigin = /^chrome-extension:\/\/[a-z]{32}$/.test(origin);
    const corsHeaders = {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    if (isExtOrigin) corsHeaders['Access-Control-Allow-Origin'] = origin;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }
    if (!isExtOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
      return;
    }
    let body;
    try { body = await parseBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }));
      return;
    }
    try {
      const { poolId, sender, tokenIn, tokenOut, amountIn, slippage } = body;
      if (!poolId || !sender || tokenIn === undefined || tokenOut === undefined || !amountIn) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: 'Missing required fields: poolId, sender, tokenIn, tokenOut, amountIn' }));
        return;
      }
      if (!/^[A-Z2-7]{58}$/.test(sender)) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: 'Invalid sender address' }));
        return;
      }
      // Validate poolId and token IDs are non-negative integers
      if (!Number.isInteger(Number(poolId)) || Number(poolId) <= 0 ||
          !Number.isInteger(Number(tokenIn)) || Number(tokenIn) < 0 ||
          !Number.isInteger(Number(tokenOut)) || Number(tokenOut) < 0) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: 'poolId, tokenIn, tokenOut must be non-negative integers' }));
        return;
      }
      // Validate amountIn is a positive decimal string
      if (!/^(\d+(\.\d+)?|\.\d+)$/.test(String(amountIn)) || parseFloat(String(amountIn)) <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: 'Invalid amountIn: must be a positive decimal number' }));
        return;
      }
      // Clamp slippage to 0-0.50 (server-side enforcement independent of UI)
      const slippageNum = slippage !== undefined ? Number(slippage) : 0.01;
      if (isNaN(slippageNum) || slippageNum < 0 || slippageNum > 0.50) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: 'slippage must be between 0 and 0.5' }));
        return;
      }
      // Resolve underlying token IDs to wrapped pool token IDs using Snowball pool config.
      // humble_swap_txn compares against wrapped pool tokens (tokA/tokB); passing
      // underlying IDs (e.g. 302190 aUSDC vs 395614 wrapped aUSDC) causes a mismatch.
      let resolvedTokenIn = Number(tokenIn);
      let resolvedTokenOut = Number(tokenOut);
      try {
        const poolsRes = await fetch("https://api.snowballswap.com/config/pools");
        if (!poolsRes.ok) throw new Error(`Snowball /config/pools returned ${poolsRes.status}`);
        const poolsData = await poolsRes.json();
        if (!poolsData || !Array.isArray(poolsData.pools)) throw new Error("Snowball /config/pools response missing pools array");
        const poolCfg = poolsData.pools.find(p => Number(p.poolId) === Number(poolId));
        const rawUtm = poolCfg?.tokens?.underlyingToWrapped ?? {};
        // Validate UTM entries: keys must be non-negative integer strings, values positive integers
        const utm = {};
        for (const [k, v] of Object.entries(rawUtm)) {
          if (/^\d+$/.test(k) && Number.isInteger(v) && Number(v) > 0) utm[k] = v;
        }
        // Do NOT pre-resolve tokenIn=0 or tokenOut=0 — humble_swap_txn handles
        // native VOI (0) internally via VOI_NATIVE_OVERRIDES.
        if (Number(tokenIn) !== 0 && utm[String(tokenIn)] !== undefined) resolvedTokenIn = utm[String(tokenIn)];
        if (Number(tokenOut) !== 0 && utm[String(tokenOut)] !== undefined) resolvedTokenOut = utm[String(tokenOut)];
      } catch (utmErr) {
        console.warn("[voi-swap] Snowball config fetch failed, continuing with raw IDs:", utmErr.message);
        // Continue with unresolved IDs
      }
      const result = await callVoiSwapFn('humble_swap_txn', {
        network: 'voi-mainnet',
        poolId: Number(poolId),
        sender: String(sender),
        tokenIn: resolvedTokenIn,
        tokenOut: resolvedTokenOut,
        amountIn: String(amountIn),
        slippage: slippageNum,
      });
      if (!result || !result.txns) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ ok: false, error: result?.error || 'Swap transaction build failed' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: true, txns: result.txns }));
    } catch (err) {
      console.error('[/voi-swap] error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({ ok: false, error: err.message || 'Internal error' }));
    }
    return;
  }

  // ── Coinbase Onramp session token ──
  if (url.pathname === "/api/coinbase-session") {
    if (req.method === "OPTIONS") {
      const origin = req.headers.origin || "";
      const optHeaders = {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
      };
      if (/^chrome-extension:\/\/[a-z]{32}$/.test(origin)) {
        optHeaders["Access-Control-Allow-Origin"] = origin;
      }
      res.writeHead(204, optHeaders);
      res.end();
      return;
    }
    if (req.method === "POST") {
      let body;
      try { body = await parseBody(req); } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
        return;
      }
      await handleCoinbaseSession(req, res, body);
      return;
    }
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }





  // ── WC Relay Bridge ────────────────────────────────────────────────────────
  // Proxies WalletConnect relay WebSocket messages via HTTP polling.
  // Chrome MV3 service workers can't receive WebSocket push notifications.
  if (url.pathname.startsWith("/wc-bridge")) {
    const origin = req.headers.origin || "";
    const isExtOrigin = /^chrome-extension:\/\/[a-z]{32}$/.test(origin);
    const bridgeCors = {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-AlgoVoi-Key",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    };
    if (isExtOrigin) bridgeCors["Access-Control-Allow-Origin"] = origin;

    if (req.method === "OPTIONS") {
      res.writeHead(204, bridgeCors);
      res.end();
      return;
    }

    // Auth check
    const apiKey = req.headers["x-algovoi-key"] || "";
    const ALGOVOI_API_KEY = process.env.ALGOVOI_API_KEY || "55318ce48a353fe5d9a01bd85c4c4c52dd73d2197512f42c1ad41b443de4ca85";
    if (apiKey !== ALGOVOI_API_KEY) {
      res.writeHead(401, { "Content-Type": "application/json", ...bridgeCors });
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    // POST /wc-bridge/listen — start listening on a relay topic
    if (url.pathname === "/wc-bridge/listen" && req.method === "POST") {
      let body;
      try { body = await parseBody(req); } catch {
        res.writeHead(400, { "Content-Type": "application/json", ...bridgeCors });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      const { topic, wsUrl } = body;
      // XXIII-1: validate topic is a 64-char hex string (WC topic format)
      if (!topic || !/^[a-f0-9]{64}$/.test(topic)) {
        res.writeHead(400, { "Content-Type": "application/json", ...bridgeCors });
        res.end(JSON.stringify({ ok: false, error: "Invalid topic format" }));
        return;
      }
      // XXIII-2: wsUrl must be wss:// to relay.walletconnect.org (prevent SSRF)
      if (!wsUrl || !/^wss:\/\/relay\.walletconnect\.(org|com)\//.test(wsUrl)) {
        res.writeHead(400, { "Content-Type": "application/json", ...bridgeCors });
        res.end(JSON.stringify({ ok: false, error: "Invalid relay URL" }));
        return;
      }
      await startListener(topic, wsUrl);
      res.writeHead(200, { "Content-Type": "application/json", ...bridgeCors });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /wc-bridge/:topic — poll for messages
    const topicMatch = url.pathname.match(/^\/wc-bridge\/([a-f0-9]{64})$/);
    if (topicMatch && req.method === "GET") {
      const topic = topicMatch[1];
      const messages = getMessages(topic);
      res.writeHead(200, { "Content-Type": "application/json", ...bridgeCors });
      res.end(JSON.stringify({ messages }));
      return;
    }

    // POST /wc-bridge/:topic — agent pushes a message directly (bypasses relay)
    if (topicMatch && req.method === "POST") {
      const topic = topicMatch[1];
      let body;
      try { body = await parseBody(req); } catch {
        res.writeHead(400, { "Content-Type": "application/json", ...bridgeCors });
        res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
        return;
      }
      // XXIII-3: validate message exists and isn't oversized
      if (!body.message || typeof body.message !== "string" || body.message.length > 10000) {
        res.writeHead(400, { "Content-Type": "application/json", ...bridgeCors });
        res.end(JSON.stringify({ ok: false, error: "Missing or oversized message" }));
        return;
      }
      // XXIII-9: Always use server-side timestamp (ignore client publishedAt)
      pushMessage(topic, {
        topic,
        message: body.message,
        publishedAt: Date.now(),
      });
      console.log(`[wc-bridge] Direct push for ${topic.slice(0,8)} (${body.message.length} chars)`);
      res.writeHead(200, { "Content-Type": "application/json", ...bridgeCors });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /wc-bridge/stop — stop listening
    if (url.pathname === "/wc-bridge/stop" && req.method === "POST") {
      let body;
      try { body = await parseBody(req); } catch { body = {}; }
      if (body.topic) stopListener(body.topic);
      res.writeHead(200, { "Content-Type": "application/json", ...bridgeCors });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json", ...bridgeCors });
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  try {
    if (req.method === "POST") {
      let body;
      try { body = await parseBody(req); } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: invalid or empty JSON body" }, id: null }));
        return;
      }
      console.log("MCP POST:", req.headers["mcp-session-id"] ? "session=" + req.headers["mcp-session-id"].slice(0,8) : "no-session", "payment=" + !!req.headers["payment-signature"]); await handlePost(req, res, body);
    } else if (req.method === "GET") {
      await handleGet(req, res);
    } else if (req.method === "DELETE") {
      await handleDelete(req, res);
    } else {
      res.writeHead(405);
      res.end("Method Not Allowed");
    }
  } catch (err) {
    console.error("Error handling request:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        })
      );
    }
  }
});

httpServer.listen(PORT, () => {
  const accepts = buildPaymentRequirements();
  console.log(`UluMCP HTTP server listening on port ${PORT}`);
  if (accepts.length > 0) {
    console.log(`x402 payment required: ${accepts.length} accepted payment option(s)`);
    for (const a of accepts) {
      console.log(`  ${a.network} → ${a.payTo} (${a.amount} of asset ${a.asset})`);
    }
  } else {
    console.log("x402 payment not configured (open access)");
  }
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  for (const sid of Object.keys(transports)) {
    await transports[sid].close().catch(() => {});
    delete transports[sid];
  }
  httpServer.close();
  process.exit(0);
});
