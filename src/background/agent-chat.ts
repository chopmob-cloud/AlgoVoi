/**
 * AI Agent Chat — tries direct actions first, falls back to AI.
 *
 * Direct actions: swap, send, balance, resolve, register, price
 *   → Zero AI tokens, calls MCP tools directly
 *
 * AI fallback: conversational/ambiguous queries
 *   → Calls server-side agent_chat (Claude API + categorised tools)
 */

import { initSession, callTool } from "./mcp-client";
import { parseDirectAction, executeDirectAction } from "./direct-actions";

export interface PendingTxn {
  tool: string;
  network: string;
  txns: string[]; // base64 unsigned transactions
  action: string;
  sender?: string;
  receiver?: string;
  amount?: string;
}

export interface AgentChatResult {
  reply: string;
  pendingTxns?: PendingTxn[];
}

export async function handleAgentChat(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  activeAddress: string,
  category: string = "general",
  balance?: string
): Promise<AgentChatResult> {
  const current = messages[messages.length - 1];
  if (!current || current.role !== "user") {
    throw new Error("No user message to send");
  }

  // 1. Try direct action (zero AI tokens)
  const action = parseDirectAction(current.content);
  if (action) {
    console.log(`[agent-chat] direct action: ${action.type}`, action.params);
    return executeDirectAction(action, activeAddress, balance);
  }

  // 2. Fall back to AI (conversational/ambiguous)
  console.log(`[agent-chat] AI fallback: "${current.content.slice(0, 50)}"`);
  const sessionId = await initSession();
  const history = messages.slice(0, -1);

  const result = await callTool(sessionId, "agent_chat", {
    message: current.content,
    address: activeAddress,
    category,
    ...(balance ? { balance } : {}),
    ...(history.length > 0 ? { history } : {}),
  });

  const textContent = result.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text;
  if (!textContent) throw new Error("AI returned no response");

  const meta = result._meta as { pendingTxns?: PendingTxn[] } | undefined;
  const pendingTxns = meta?.pendingTxns;

  return { reply: textContent, pendingTxns };
}
