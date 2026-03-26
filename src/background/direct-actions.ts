/**
 * Direct Action Parser — handles structured commands without AI.
 * Parses user input, calls MCP tools directly, returns results.
 * Only falls back to AI for ambiguous/conversational queries.
 *
 * Chain-aware: Voi uses HumbleSwap/enVoi/Snowball, Algorand uses Haystack/NFD/Pera.
 */

import algosdk from "algosdk";
import { initSession, callTool } from "./mcp-client";
import type { PendingTxn, AgentChatResult } from "./agent-chat";

// ── Pattern matchers ──────────────────────────────────────────

const SWAP_RE = /^swap\s+([\d.]+)\s+(\w+)\s+(?:to|for)\s+(\w+)/i;
const SEND_RE = /^send\s+([\d.]+)\s+(\w+)\s+to\s+(.+)/i;
const BALANCE_RE = /^(?:wallet\s*)?balance$|^how much|^my balance/i;
const RESOLVE_VOI_RE = /^(?:resolve|lookup|who is|whois)\s+(.+\.voi)$/i;
const REGISTER_VOI_RE = /^(?:register|buy|purchase)\s+(.+\.voi)$/i;
const RESOLVE_NFD_RE = /^(?:resolve|lookup|who is|whois)\s+(.+\.algo)$/i;
const RESOLVE_GENERIC_RE = /^(?:resolve|lookup|who is|whois)\s+(.+)$/i;
const PRICE_RE = /^(?:price|value)\s+(?:of\s+)?(\w+)$/i;

interface ParsedAction {
  type: "swap" | "send" | "balance" | "resolve" | "register" | "price";
  params: Record<string, string>;
}

export function parseDirectAction(input: string, chain: string = "voi"): ParsedAction | null {
  const trimmed = input.trim();

  let m = trimmed.match(SWAP_RE);
  if (m) return { type: "swap", params: { amount: m[1], from: m[2].toUpperCase(), to: m[3].toUpperCase() } };

  m = trimmed.match(SEND_RE);
  if (m) return { type: "send", params: { amount: m[1], asset: m[2].toUpperCase(), to: m[3].trim() } };

  if (BALANCE_RE.test(trimmed)) return { type: "balance", params: {} };

  // Chain-specific name resolution
  if (chain === "voi") {
    m = trimmed.match(RESOLVE_VOI_RE);
    if (m) return { type: "resolve", params: { name: m[1].toLowerCase() } };
    m = trimmed.match(REGISTER_VOI_RE);
    if (m) return { type: "register", params: { name: m[1].toLowerCase() } };
  } else {
    m = trimmed.match(RESOLVE_NFD_RE);
    if (m) return { type: "resolve", params: { name: m[1].toLowerCase() } };
  }

  // Generic resolve for either chain (no TLD)
  m = trimmed.match(RESOLVE_GENERIC_RE);
  if (m) return { type: "resolve", params: { name: m[1].trim() } };

  m = trimmed.match(PRICE_RE);
  if (m) return { type: "price", params: { token: m[1].toUpperCase() } };

  return null; // Falls back to AI
}

// ── Voi action executors ──────────────────────────────────────

async function resolveTokensVoi(): Promise<Map<string, { id: string; symbol: string; name: string; decimals: number }>> {
  const sessionId = await initSession();
  const result = await callTool(sessionId, "snowball_tokens", {});
  const text = result.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!text) return new Map();

  let tokens: Array<{ id: unknown; symbol: unknown; name: unknown; decimals: unknown }> = [];
  try {
    tokens = (JSON.parse(text).tokens as typeof tokens) || [];
  } catch {
    return new Map();
  }
  const map = new Map<string, { id: string; symbol: string; name: string; decimals: number }>();
  for (const t of tokens) {
    const sym = String(t.symbol ?? "");
    if (!sym) continue;
    map.set(sym.toUpperCase(), {
      id: String(t.id ?? ""),
      symbol: sym,
      name: String(t.name ?? ""),
      decimals: Number(t.decimals ?? 0),
    });
  }
  map.set("VOI", { id: "0", symbol: "VOI", name: "Voi", decimals: 6 });
  return map;
}

async function executeSwapVoi(
  params: Record<string, string>,
  address: string
): Promise<AgentChatResult> {
  const sessionId = await initSession();
  const tokenMap = await resolveTokensVoi();
  const fromInfo = tokenMap.get(params.from);
  const toInfo = tokenMap.get(params.to);
  if (!fromInfo) return { reply: `Unknown token: ${params.from}` };
  if (!toInfo) return { reply: `Unknown token: ${params.to}` };

  const wVOI = "390001";
  const fromId = params.from === "VOI" ? wVOI : fromInfo.id;
  const toId = params.to === "VOI" ? wVOI : toInfo.id;

  const poolsResult = await callTool(sessionId, "humble_pools", {});
  const poolsText = poolsResult.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!poolsText) return { reply: "Could not fetch pools." };

  const pools = JSON.parse(poolsText).pools || [];
  const pool = pools.find((p: { tokA: string; tokB: string }) =>
    (p.tokA === fromId && p.tokB === toId) || (p.tokA === toId && p.tokB === fromId)
  );
  if (!pool) return { reply: `No pool found for ${params.from}/${params.to}.` };

  const swapResult = await callTool(sessionId, "humble_swap_txn", {
    network: "voi-mainnet",
    poolId: parseInt(pool.poolId, 10),
    sender: address,
    tokenIn: params.from === "VOI" ? 0 : parseInt(fromId, 10),
    tokenOut: parseInt(toId, 10),
    amountIn: params.amount,
  });

  const swapText = swapResult.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!swapText) return { reply: "Could not build swap transaction." };

  const swapData = JSON.parse(swapText);
  if (swapData.txns && Array.isArray(swapData.txns)) {
    return {
      reply: `Swap ${params.amount} ${params.from} → ${params.to}`,
      pendingTxns: [{
        tool: "humble_swap_txn",
        network: "voi-mainnet",
        txns: swapData.txns,
        action: "swap",
        sender: address,
        amount: params.amount,
      }],
    };
  }
  return { reply: swapData.error || "Swap transaction failed." };
}

async function executeResolveVoi(params: Record<string, string>): Promise<AgentChatResult> {
  const sessionId = await initSession();
  const result = await callTool(sessionId, "envoi_resolve_address", { name: params.name });
  const text = result.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!text) return { reply: `Could not resolve ${params.name}` };

  const data = JSON.parse(text);
  const entry = data.results?.[0];
  if (!entry) return { reply: `${params.name} not found.` };

  if (!algosdk.isValidAddress(entry.address)) {
    return { reply: `Name service returned an invalid address for ${params.name}` };
  }
  return { reply: `${params.name} → ${entry.address}` };
}

async function executeRegisterVoi(
  params: Record<string, string>,
  address: string
): Promise<AgentChatResult> {
  const sessionId = await initSession();
  const label = params.name.replace(/\.voi$/, "").replace(/\..+$/, "");

  const result = await callTool(sessionId, "envoi_purchase_txn", {
    name: label,
    sender: address,
  });

  const text = result.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!text) return { reply: `Could not build registration for ${params.name}` };

  const data = JSON.parse(text);
  if (data.txns) {
    return {
      reply: `Register ${params.name}`,
      pendingTxns: [{
        tool: "envoi_purchase_txn",
        network: "voi-mainnet",
        txns: data.txns,
        action: "register",
        sender: address,
        amount: data.price || "unknown",
      }],
    };
  }
  return { reply: data.error || `Registration failed for ${params.name}` };
}

async function executePriceVoi(params: Record<string, string>): Promise<AgentChatResult> {
  const tokenMap = await resolveTokensVoi();
  const info = tokenMap.get(params.token);
  if (!info) return { reply: `Token ${params.token} not found.` };

  const sessionId = await initSession();
  const result = await callTool(sessionId, "humble_token_price", {
    tokenId: parseInt(info.id, 10),
  });

  const text = result.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!text) return { reply: `${info.symbol}: ${info.name} (${info.decimals} decimals)` };

  const priceData = JSON.parse(text);
  return { reply: `${info.symbol} (${info.name}): ${JSON.stringify(priceData.prices || priceData).slice(0, 200)}` };
}

// ── Algorand action executors ─────────────────────────────────

async function executeSwapAlgorand(
  params: Record<string, string>,
  address: string
): Promise<AgentChatResult> {
  const sessionId = await initSession();

  // Resolve common Algorand ASA IDs
  const ALGO_ASSETS: Record<string, number> = {
    ALGO: 0,
    USDC: 31566704,
    USDT: 312769,
    GOBTC: 386192725,
    GOETH: 386195940,
  };

  const fromId = ALGO_ASSETS[params.from];
  const toId = ALGO_ASSETS[params.to];

  if (fromId === undefined) {
    // Try Pera search for unknown tokens
    const searchResult = await callTool(sessionId, "pera_asset_search", { query: params.from, verifiedOnly: true });
    const searchText = searchResult.content?.find((c: { type: string }) => c.type === "text")?.text;
    if (searchText) {
      const assets = JSON.parse(searchText);
      if (Array.isArray(assets) && assets.length > 0) {
        return { reply: `Found asset "${assets[0].name}" (ID: ${assets[0].asset_id}). Use the asset ID for precise swaps.` };
      }
    }
    return { reply: `Unknown Algorand asset: ${params.from}. Supported: ALGO, USDC, USDT, goBTC, goETH.` };
  }
  if (toId === undefined) {
    return { reply: `Unknown Algorand asset: ${params.to}. Supported: ALGO, USDC, USDT, goBTC, goETH.` };
  }

  // Convert to base units (ALGO = 6 decimals, USDC = 6, USDT = 6)
  const cleanAmount = params.amount.trim();
  if (!/^\d+(\.\d+)?$/.test(cleanAmount)) {
    return { reply: `Invalid amount: "${params.amount}"` };
  }
  const [intStr, fracStr = ""] = cleanAmount.split(".");
  const fracPadded = fracStr.slice(0, 6).padEnd(6, "0");
  const baseAmount = (BigInt(intStr) * 1_000_000n + BigInt(fracPadded)).toString();

  const swapResult = await callTool(sessionId, "haystack_swap_txn", {
    fromASAID: fromId,
    toASAID: toId,
    amount: parseInt(baseAmount, 10),
    address,
    slippage: 1,
  });

  const swapText = swapResult.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!swapText) return { reply: "Could not build Haystack swap transaction." };

  const swapData = JSON.parse(swapText);
  if (swapData.txns && Array.isArray(swapData.txns)) {
    return {
      reply: `Swap ${params.amount} ${params.from} → ${params.to} via Haystack Router\n${swapData.summary ? `Route: ${JSON.stringify(swapData.summary.route || []).slice(0, 100)}` : ""}`,
      pendingTxns: [{
        tool: "haystack_swap_txn",
        network: "algorand-mainnet",
        txns: swapData.txns,
        action: "swap",
        sender: address,
        amount: params.amount,
      }],
    };
  }
  return { reply: swapData.error || "Haystack swap failed." };
}

async function executeResolveAlgorand(params: Record<string, string>): Promise<AgentChatResult> {
  const sessionId = await initSession();
  const nameOrId = params.name.replace(/\.algo$/, "") + ".algo";

  const result = await callTool(sessionId, "nfd_get", { nameOrID: nameOrId, view: "brief" });
  const text = result.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!text) return { reply: `Could not resolve ${params.name}` };

  const data = JSON.parse(text);
  const owner = data.owner || data.depositAccount || data.caAlgo?.[0];
  if (!owner) return { reply: `${params.name} found but no owner address.` };

  if (!algosdk.isValidAddress(owner)) {
    return { reply: `NFD returned an invalid address for ${params.name}` };
  }

  const parts = [`${data.name || params.name} → ${owner}`];
  if (data.properties?.verified?.avatar) parts.push(`Avatar: ${data.properties.verified.avatar}`);
  if (data.properties?.verified?.twitter) parts.push(`Twitter: ${data.properties.verified.twitter}`);
  return { reply: parts.join("\n") };
}

async function executePriceAlgorand(params: Record<string, string>): Promise<AgentChatResult> {
  const sessionId = await initSession();

  // Search Pera for the asset
  const searchResult = await callTool(sessionId, "pera_asset_search", { query: params.token, verifiedOnly: true });
  const searchText = searchResult.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!searchText) return { reply: `Asset ${params.token} not found.` };

  const assets = JSON.parse(searchText);
  if (!Array.isArray(assets) || assets.length === 0) {
    return { reply: `No verified asset found for ${params.token}.` };
  }

  const asset = assets[0];
  const parts = [`${asset.name} (${asset.unit_name})`];
  if (asset.usd_value) parts.push(`USD: $${asset.usd_value}`);
  parts.push(`ID: ${asset.asset_id}`);
  parts.push(`Verification: ${asset.verification_tier}`);
  return { reply: parts.join(" | ") };
}

// ── Shared executors (both chains) ────────────────────────────

async function executeSend(
  params: Record<string, string>,
  address: string,
  chain: string
): Promise<AgentChatResult> {
  const network = chain === "algorand" ? "algorand-mainnet" : "voi-mainnet";
  const nativeAsset = chain === "algorand" ? "ALGO" : "VOI";
  const sessionId = await initSession();
  let receiver = params.to;

  // Resolve names
  if (chain === "voi" && receiver.endsWith(".voi")) {
    const resolveResult = await callTool(sessionId, "envoi_resolve_address", { name: receiver });
    const resolveText = resolveResult.content?.find((c: { type: string }) => c.type === "text")?.text;
    if (resolveText) {
      let data: Record<string, unknown>;
      try { data = JSON.parse(resolveText) as Record<string, unknown>; } catch { return { reply: `Could not resolve ${params.to}` }; }
      const resolved = (data.results as Array<Record<string, unknown>> | undefined)?.[0]?.address as string | undefined ?? data.address as string | undefined;
      if (resolved && algosdk.isValidAddress(resolved)) { receiver = resolved; }
      else { return { reply: `Could not resolve ${params.to}` }; }
    }
  } else if (chain === "algorand" && receiver.endsWith(".algo")) {
    const resolveResult = await callTool(sessionId, "nfd_get", { nameOrID: receiver, view: "tiny" });
    const resolveText = resolveResult.content?.find((c: { type: string }) => c.type === "text")?.text;
    if (resolveText) {
      const data = JSON.parse(resolveText);
      const resolved = data.owner || data.depositAccount || data.caAlgo?.[0];
      if (resolved && algosdk.isValidAddress(resolved)) { receiver = resolved; }
      else { return { reply: `Could not resolve ${params.to}` }; }
    }
  }

  if (!algosdk.isValidAddress(receiver)) {
    return { reply: `Invalid recipient address: ${receiver}` };
  }

  // Safe decimal → microunit conversion
  const cleanAmount = params.amount.trim();
  if (!/^\d+(\.\d+)?$/.test(cleanAmount)) {
    return { reply: `Invalid amount: "${params.amount}"` };
  }
  const [intStr, fracStr = ""] = cleanAmount.split(".");
  const fracPadded = fracStr.slice(0, 6).padEnd(6, "0");
  const microAmount = (BigInt(intStr) * 1_000_000n + BigInt(fracPadded)).toString();

  if (params.asset === nativeAsset) {
    const result = await callTool(sessionId, "payment_txn", {
      network,
      sender: address,
      receiver,
      amount: microAmount,
    });

    const text = result.content?.find((c: { type: string }) => c.type === "text")?.text;
    if (text) {
      const data = JSON.parse(text);
      if (data.txns) {
        // XXII-9: Show full resolved address so user can verify name resolution
        const nameWasResolved = receiver !== params.to;
        const replyText = nameWasResolved
          ? `Send ${params.amount} ${nativeAsset} to ${params.to} (${receiver})`
          : `Send ${params.amount} ${nativeAsset} to ${params.to}`;
        return {
          reply: replyText,
          pendingTxns: [{
            tool: "payment_txn",
            network,
            txns: data.txns,
            action: "payment",
            sender: address,
            receiver,
            amount: microAmount,
          }],
        };
      }
    }
  }

  return { reply: `Token transfers for ${params.asset} not yet supported in direct actions. Try the AI chat.` };
}

// ── Main executor ─────────────────────────────────────────────

export async function executeDirectAction(
  action: ParsedAction,
  address: string,
  balance?: string,
  chain: string = "voi"
): Promise<AgentChatResult> {
  const nativeAsset = chain === "algorand" ? "ALGO" : "VOI";

  switch (action.type) {
    case "balance":
      return { reply: balance ? `${balance} ${nativeAsset}` : "Balance unavailable." };

    case "swap":
      return chain === "algorand"
        ? executeSwapAlgorand(action.params, address)
        : executeSwapVoi(action.params, address);

    case "send":
      return executeSend(action.params, address, chain);

    case "resolve":
      return chain === "algorand"
        ? executeResolveAlgorand(action.params)
        : executeResolveVoi(action.params);

    case "register":
      if (chain === "algorand") {
        return { reply: "NFD registration is done via nf.domains — use 'lookup' to search available names." };
      }
      return executeRegisterVoi(action.params, address);

    case "price":
      return chain === "algorand"
        ? executePriceAlgorand(action.params)
        : executePriceVoi(action.params);
  }
}
