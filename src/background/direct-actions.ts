/**
 * Direct Action Parser — handles structured commands without AI.
 * Parses user input, calls MCP tools directly, returns results.
 * Only falls back to AI for ambiguous/conversational queries.
 */

import algosdk from "algosdk";
import { initSession, callTool } from "./mcp-client";
import type { PendingTxn, AgentChatResult } from "./agent-chat";

// ── Pattern matchers ──────────────────────────────────────────

const SWAP_RE = /^swap\s+([\d.]+)\s+(\w+)\s+(?:to|for)\s+(\w+)/i;
const SEND_RE = /^send\s+([\d.]+)\s+(\w+)\s+to\s+(.+)/i;
const BALANCE_RE = /^(?:wallet\s*)?balance$|^how much|^my balance/i;
const RESOLVE_RE = /^(?:resolve|lookup|who is|whois)\s+(.+\.voi)$/i;
const REGISTER_RE = /^(?:register|buy|purchase)\s+(.+\.voi)$/i;
const PRICE_RE = /^(?:price|value)\s+(?:of\s+)?(\w+)$/i;

interface ParsedAction {
  type: "swap" | "send" | "balance" | "resolve" | "register" | "price";
  params: Record<string, string>;
}

export function parseDirectAction(input: string): ParsedAction | null {
  const trimmed = input.trim();

  let m = trimmed.match(SWAP_RE);
  if (m) return { type: "swap", params: { amount: m[1], from: m[2].toUpperCase(), to: m[3].toUpperCase() } };

  m = trimmed.match(SEND_RE);
  if (m) return { type: "send", params: { amount: m[1], asset: m[2].toUpperCase(), to: m[3].trim() } };

  if (BALANCE_RE.test(trimmed)) return { type: "balance", params: {} };

  m = trimmed.match(RESOLVE_RE);
  if (m) return { type: "resolve", params: { name: m[1].toLowerCase() } };

  m = trimmed.match(REGISTER_RE);
  if (m) return { type: "register", params: { name: m[1].toLowerCase() } };

  m = trimmed.match(PRICE_RE);
  if (m) return { type: "price", params: { token: m[1].toUpperCase() } };

  return null; // Falls back to AI
}

// ── Action executors ──────────────────────────────────────────

async function resolveTokens(): Promise<Map<string, { id: string; symbol: string; name: string; decimals: number }>> {
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
  // wVOI alias
  map.set("VOI", { id: "0", symbol: "VOI", name: "Voi", decimals: 6 });
  return map;
}

async function executeSwap(
  params: Record<string, string>,
  address: string
): Promise<AgentChatResult> {
  const sessionId = await initSession();

  // 1. Resolve token symbols to IDs
  const tokenMap = await resolveTokens();
  const fromInfo = tokenMap.get(params.from);
  const toInfo = tokenMap.get(params.to);
  if (!fromInfo) return { reply: `Unknown token: ${params.from}` };
  if (!toInfo) return { reply: `Unknown token: ${params.to}` };

  // wVOI is 390001 on HumbleSwap pools
  const wVOI = "390001";
  const fromId = params.from === "VOI" ? wVOI : fromInfo.id;
  const toId = params.to === "VOI" ? wVOI : toInfo.id;

  // 2. Find pool
  const poolsResult = await callTool(sessionId, "humble_pools", {});
  const poolsText = poolsResult.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!poolsText) return { reply: "Could not fetch pools." };

  const pools = JSON.parse(poolsText).pools || [];
  const pool = pools.find((p: { tokA: string; tokB: string }) =>
    (p.tokA === fromId && p.tokB === toId) || (p.tokA === toId && p.tokB === fromId)
  );

  if (!pool) return { reply: `No pool found for ${params.from}/${params.to}.` };

  // 3. Build swap txn — use 0 for native VOI
  const poolId = parseInt(pool.poolId, 10);
  const tokenIn = params.from === "VOI" ? 0 : parseInt(fromId, 10);
  const tokenOut = parseInt(toId, 10);

  const swapResult = await callTool(sessionId, "humble_swap_txn", {
    network: "voi-mainnet",
    poolId,
    sender: address,
    tokenIn,
    tokenOut,
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

async function executeSend(
  params: Record<string, string>,
  address: string
): Promise<AgentChatResult> {
  const sessionId = await initSession();
  let receiver = params.to;

  // Resolve .voi names
  if (receiver.endsWith(".voi")) {
    const resolveResult = await callTool(sessionId, "envoi_resolve_address", { name: receiver });
    const resolveText = resolveResult.content?.find((c: { type: string }) => c.type === "text")?.text;
    if (resolveText) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(resolveText) as Record<string, unknown>;
      } catch {
        return { reply: `Could not resolve ${params.to}` };
      }
      const resolved = (data.results as Array<Record<string, unknown>> | undefined)?.[0]?.address as string | undefined
        ?? data.address as string | undefined;
      if (resolved) {
        // XVIII-1: Validate the resolved address from the MCP server before use.
        // A compromised server could return an attacker-controlled address.
        if (!algosdk.isValidAddress(resolved)) {
          return { reply: `Name service returned an invalid address for ${params.to}` };
        }
        receiver = resolved;
      } else {
        return { reply: `Could not resolve ${params.to}` };
      }
    }
  }

  // XVIII-1: Validate raw receiver address (non-.voi path) before sending to MCP.
  if (!algosdk.isValidAddress(receiver)) {
    return { reply: `Invalid recipient address: ${receiver}` };
  }

  // XVIII-2: Safe decimal → microunit conversion without float precision loss.
  // parseFloat(".")  = NaN; large integers lose precision in IEEE 754.
  // Use BigInt arithmetic matching parseDecimalToAtomic() in message-handler.ts.
  const cleanAmount = params.amount.trim();
  if (!/^\d+(\.\d+)?$/.test(cleanAmount)) {
    return { reply: `Invalid amount: "${params.amount}"` };
  }
  const [intStr, fracStr = ""] = cleanAmount.split(".");
  const fracPadded = fracStr.slice(0, 6).padEnd(6, "0");
  const microAmountBig = BigInt(intStr) * 1_000_000n + BigInt(fracPadded);
  const microAmount = microAmountBig.toString();

  if (params.asset === "VOI") {
    const result = await callTool(sessionId, "payment_txn", {
      network: "voi-mainnet",
      sender: address,
      receiver,
      amount: microAmount,
    });

    const text = result.content?.find((c: { type: string }) => c.type === "text")?.text;
    if (text) {
      const data = JSON.parse(text);
      if (data.txns) {
        return {
          reply: `Send ${params.amount} VOI to ${params.to}`,
          pendingTxns: [{
            tool: "payment_txn",
            network: "voi-mainnet",
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

  // ARC-200 token transfer
  // TODO: Look up token contract ID from name
  return { reply: `ARC-200 token transfers coming soon. Use VOI for now.` };
}

async function executeResolve(params: Record<string, string>): Promise<AgentChatResult> {
  const sessionId = await initSession();
  const result = await callTool(sessionId, "envoi_resolve_address", { name: params.name });
  const text = result.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!text) return { reply: `Could not resolve ${params.name}` };

  const data = JSON.parse(text);
  const entry = data.results?.[0];
  if (!entry) return { reply: `${params.name} not found.` };

  return { reply: `${params.name} → ${entry.address}` };
}

async function executeRegister(
  params: Record<string, string>,
  address: string
): Promise<AgentChatResult> {
  const sessionId = await initSession();

  // Extract label from full name (e.g. "nugget.voi" → "nugget")
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

async function executePrice(params: Record<string, string>): Promise<AgentChatResult> {
  const tokenMap = await resolveTokens();
  const info = tokenMap.get(params.token);
  if (!info) return { reply: `Token ${params.token} not found.` };

  // Get price from HumbleSwap
  const sessionId = await initSession();
  const result = await callTool(sessionId, "humble_token_price", {
    tokenId: parseInt(info.id, 10),
  });

  const text = result.content?.find((c: { type: string }) => c.type === "text")?.text;
  if (!text) return { reply: `${info.symbol}: ${info.name} (${info.decimals} decimals)` };

  const priceData = JSON.parse(text);
  return { reply: `${info.symbol} (${info.name}): ${JSON.stringify(priceData.prices || priceData).slice(0, 200)}` };
}

// ── Main executor ─────────────────────────────────────────────

export async function executeDirectAction(
  action: ParsedAction,
  address: string,
  balance?: string
): Promise<AgentChatResult> {
  switch (action.type) {
    case "balance":
      return { reply: balance ? `${balance} VOI` : "Balance unavailable." };
    case "swap":
      return executeSwap(action.params, address);
    case "send":
      return executeSend(action.params, address);
    case "resolve":
      return executeResolve(action.params);
    case "register":
      return executeRegister(action.params, address);
    case "price":
      return executePrice(action.params);
  }
}
