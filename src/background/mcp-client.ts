/**
 * MCP client for UluMCP — handles MCP session init, x402 payment, and tool calls.
 * Currently used for enVoi name resolution on Voi mainnet.
 *
 * Flow:
 *   1. POST /mcp (initialize) → get Mcp-Session-Id header
 *   2. POST /mcp (tools/call) with session ID → 402 with payment requirements
 *   3. Build + sign Voi payment txn, submit to chain, encode as PAYMENT-SIGNATURE
 *   4. Retry tools/call with PAYMENT-SIGNATURE header → get tool result
 */

import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import { getSuggestedParams, submitTransaction, getAccountState } from "./chain-clients";
import { requestApproval } from "./approval-handler";
import { randomId } from "@shared/utils/crypto";
import { X402_VERSION } from "@shared/constants";

// Mirror the same native spending cap used by x402-handler so enVoi resolution
// cannot bypass the user's configured payment safety limit.
const SPENDING_CAP_NATIVE = 10_000_000n; // 10 VOI

const MCP_ENDPOINT = "https://mcp.ilovechicken.co.uk/mcp";
const MCP_ACCEPT = "application/json, text/event-stream";

// ── Types ─────────────────────────────────────────────────────────────────────

interface McpPaymentOption {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

interface Mcp402Body {
  x402Version: number;
  error: string;
  accepts: McpPaymentOption[];
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface EnvoiResolveResult {
  address: string;
  displayName: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse an SSE text/event-stream body and return the payload from the first
 * `event: message` event. If no explicit event type is present (server omits
 * the `event:` line), falls back to the first well-formed `data:` line.
 * Ignores earlier `data:` lines from non-message events (e.g. `event: partial`)
 * so a crafted multi-event stream cannot inject a malicious first payload.
 */
function parseSseResponse(text: string): unknown {
  const lines = text.split("\n");
  let expectMessage = false;   // true after we've seen "event: message"
  let firstData: unknown = undefined; // fallback: first data line regardless of event type

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      expectMessage = line.trim() === "event: message";
    } else if (line.startsWith("data: ")) {
      try {
        const parsed = JSON.parse(line.slice(6));
        if (firstData === undefined) firstData = parsed; // save as fallback
        if (expectMessage) return parsed;               // prefer event: message
      } catch {
        // skip malformed lines
      }
      expectMessage = false; // reset after consuming or skipping a data line
    }
  }

  return firstData ?? null; // fall back to first data line if no event: message found
}

// ── MCP session ───────────────────────────────────────────────────────────────

// 30-second hard timeout for all outbound MCP requests.
const MCP_TIMEOUT_MS = 30_000;

/** Open a new MCP session and return the session ID */
async function initSession(): Promise<string> {
  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: MCP_ACCEPT },
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "algovou", version: "0.1.0" },
      },
    }),
  });

  if (!res.ok) throw new Error(`MCP init failed with status ${res.status}`);

  const sessionId = res.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP server did not return a session ID");
  return sessionId;
}

// ── x402 payment ──────────────────────────────────────────────────────────────

/**
 * Build, sign, and submit a Voi payment to satisfy an x402 requirement.
 * Returns the base64-encoded PAYMENT-SIGNATURE header value.
 * Only works with vault (non-WalletConnect) accounts.
 */
async function payVoi(pr: McpPaymentOption): Promise<string> {
  if (!algosdk.isValidAddress(pr.payTo)) {
    throw new Error(`Invalid x402 payment recipient: ${pr.payTo}`);
  }

  const meta = await walletStore.getMeta();
  const activeAccount = meta.accounts.find((a) => a.id === meta.activeAccountId);
  if (!activeAccount) throw new Error("No active account");

  if (activeAccount.type === "walletconnect") {
    throw new Error("WalletConnect accounts cannot auto-pay name resolution yet");
  }

  // M1: Validate that pr.amount is a non-negative integer string before BigInt conversion.
  // BigInt("1.5") and BigInt("abc") both throw SyntaxError; the MCP server response is
  // untrusted input and could contain a decimal or non-numeric string.
  if (!/^\d+$/.test(String(pr.amount))) {
    throw new Error(
      `Invalid payment amount from MCP server: "${pr.amount}" ` +
      `(expected a non-negative integer string)`
    );
  }
  // Reject non-positive amounts before any cap or transaction logic.
  const amount = BigInt(pr.amount);
  if (amount <= 0n) {
    throw new Error(`Invalid payment amount: ${pr.amount} (must be positive)`);
  }

  // Enforce spending cap — reuse user-configured cap or the 10 VOI default.
  const cap =
    meta.spendingCaps?.nativeMicrounits !== undefined
      ? BigInt(meta.spendingCaps.nativeMicrounits)
      : SPENDING_CAP_NATIVE;
  if (amount > cap) {
    throw new Error(
      `Resolution fee ${amount} µVOI exceeds spending cap of ${cap} µVOI. ` +
      `Adjust the cap in AlgoVoi settings or reject this payment.`
    );
  }

  const params = await getSuggestedParams("voi");

  // Pre-flight balance check — gives a clear error before the node rejects with
  // "underflow on subtracting N from sender amount M".
  const fee = BigInt((params as { minFee?: number }).minFee ?? 1000);
  const accountState = await getAccountState(activeAccount.address, "voi");
  const spendable = accountState.balance - accountState.minBalance;
  if (spendable < amount + fee) {
    throw new Error(
      `Insufficient VOI balance. ` +
      `Need ${amount + fee} µVOI but only ${spendable} µVOI spendable ` +
      `(balance: ${accountState.balance}, min balance: ${accountState.minBalance}). ` +
      `Fund your Voi account and try again.`
    );
  }

  const sk = await walletStore.getActiveSecretKey();

  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: activeAccount.address,
    receiver: pr.payTo,
    amount,
    note: new TextEncoder().encode("envoi:resolve"),
    suggestedParams: params,
  });

  const signedBytes = txn.signTxn(sk);

  // Submit (broadcast) — no need to wait for confirmation before continuing
  await submitTransaction("voi", signedBytes);

  const payload = {
    x402Version: X402_VERSION,
    scheme: pr.scheme,
    network: pr.network,
    payload: { transaction: btoa(String.fromCharCode(...signedBytes)) },
  };

  return btoa(JSON.stringify(payload));
}

// ── Tool call ─────────────────────────────────────────────────────────────────

/**
 * Call a tool on the MCP server, automatically paying the x402 fee if required.
 * Returns the tool result content.
 */
async function callTool(
  sessionId: string,
  toolName: string,
  toolArgs: Record<string, unknown>
): Promise<McpToolResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: toolName, arguments: toolArgs },
  });

  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: MCP_ACCEPT,
    "mcp-session-id": sessionId,
  };

  // First attempt — expect a 402
  let res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: baseHeaders,
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    body,
  });

  if (res.status === 402) {
    const req402 = (await res.json()) as Mcp402Body;

    // UluMCP uses "avm:voi-mainnet"; also accept plain "voi-mainnet"
    const pr = req402.accepts.find(
      (p) => p.network === "avm:voi-mainnet" || p.network === "voi-mainnet"
    );
    if (!pr) throw new Error("UluMCP requires a Voi payment but no Voi option was found");

    // Validate payTo from server before showing it to the user.
    // Use the same message as payVoi() so both checks produce consistent errors.
    if (!algosdk.isValidAddress(pr.payTo)) {
      throw new Error(`Invalid x402 payment recipient: ${pr.payTo}`);
    }

    // L7: Validate amount is a non-negative integer string BEFORE opening the
    // approval popup. The approval page renders BigInt(approval.amount) — a
    // decimal or non-numeric string would crash EnvoiPage with a SyntaxError,
    // locking the user out of resolution for the TTL window with no clear error.
    if (!/^\d+$/.test(String(pr.amount))) {
      throw new Error(
        `UluMCP returned a non-integer amount: "${pr.amount}" — aborting`
      );
    }

    // ── Gate: require explicit user approval before any VOI is spent ──────────
    // Shows the amount, recipient, and name being resolved in the approval popup.
    // payVoi() is only called if the user clicks Approve.
    const resolvedName =
      typeof toolArgs.name === "string" ? toolArgs.name : "unknown.voi";
    await requestApproval({
      kind: "envoi_payment",
      id: randomId(),
      name: resolvedName,
      payTo: pr.payTo,
      amount: String(pr.amount),
      chain: "voi",
      timestamp: Date.now(),
    });
    // ─────────────────────────────────────────────────────────────────────────

    // Post-approval lock re-check — wallet may have auto-locked during the
    // approval popup (up to APPROVAL_TTL_MS = 5 min). Fail-closed: reject
    // rather than call payVoi() with a missing or stale key.
    if (walletStore.getLockState() !== "unlocked") {
      throw new Error("Wallet locked during approval");
    }
    walletStore.resetAutoLock(); // user is actively approving — reset timer

    const paymentHeader = await payVoi(pr);

    // Retry with payment header — separate timeout so the payment window is independent.
    res = await fetch(MCP_ENDPOINT, {
      method: "POST",
      headers: { ...baseHeaders, "PAYMENT-SIGNATURE": paymentHeader },
      signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
      body,
    });
  }

  if (!res.ok) throw new Error(`MCP tool call failed with status ${res.status}`);

  const text = await res.text();
  const data = parseSseResponse(text) as {
    result?: McpToolResult;
    error?: { code: number; message: string };
  } | null;

  if (!data) throw new Error("Empty response from MCP server");
  if (data.error) throw new Error(`MCP error: ${data.error.message}`);
  if (data.result?.isError) {
    const errText = data.result.content?.[0]?.text ?? "Tool returned an error";
    throw new Error(errText);
  }
  if (!data.result) throw new Error("MCP response missing result");

  return data.result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a .voi enVoi name to a Voi address via UluMCP.
 * Costs 1 VOI (x402 payment). Wallet must be unlocked.
 *
 * @param name - e.g. "shelly" or "shelly.voi"
 */
export async function mcpResolveEnvoi(name: string): Promise<EnvoiResolveResult> {
  if (walletStore.getLockState() !== "unlocked") {
    throw new Error("Wallet is locked — unlock before resolving .voi names");
  }

  const trimmed = name.trim().toLowerCase();
  const fullName = trimmed.endsWith(".voi") ? trimmed : `${trimmed}.voi`;

  // Reject obviously invalid names before spending any network or VOI.
  const label = fullName.slice(0, -4); // strip ".voi"
  if (label.length === 0 || label.length > 63) {
    throw new Error(`Invalid .voi name length (must be 1–63 characters before .voi)`);
  }
  if (!/^[a-z0-9-]+$/.test(label)) {
    throw new Error(`Invalid .voi name: only lowercase letters, digits, and hyphens allowed`);
  }

  const sessionId = await initSession();
  const result = await callTool(sessionId, "envoi_resolve_address", { name: fullName });

  const textContent = result.content?.find((c) => c.type === "text")?.text;
  if (!textContent) throw new Error(`"${fullName}" returned no content`);

  // Defensive parse: enVoi API may return JSON or a plain address string
  let address: string | undefined;
  try {
    const parsed = JSON.parse(textContent) as Record<string, unknown>;
    // Try common response shapes from enVoi API
    address =
      (parsed.address as string | undefined) ??
      ((parsed.result as Record<string, unknown> | undefined)?.address as string | undefined) ??
      ((parsed.data as Record<string, unknown> | undefined)?.address as string | undefined);
  } catch {
    // Plain address string fallback
    if (/^[A-Z2-7]{58}$/.test(textContent.trim())) {
      address = textContent.trim();
    }
  }

  if (!address) {
    throw new Error("Name not found");
  }
  if (!algosdk.isValidAddress(address)) {
    throw new Error("Invalid response from name service");
  }

  return { address, displayName: fullName };
}
