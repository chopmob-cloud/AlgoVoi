/**
 * Tests for src/background/mcp-client.ts
 *
 * AUTO-01 — Spending cap enforcement (payVoi guard)
 * AUTO-02 — SSE response shape parsing (parseSseResponse, result extraction)
 *
 * The module under test is tested entirely through its single public export:
 *   mcpResolveEnvoi(name) → { address, displayName }
 *
 * All external I/O is replaced:
 *   - fetch          : stubbed per-test with vi.stubGlobal
 *   - walletStore    : vi.mock
 *   - chain-clients  : vi.mock (getSuggestedParams, submitTransaction)
 *   - algosdk        : vi.mock (isValidAddress, makePaymentTxnWithSuggestedParamsFromObject)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WalletMeta } from "../src/shared/types/wallet";

// ── Hoisted mocks ──────────────────────────────────────────────────────────────
// vi.mock calls are automatically hoisted above imports by Vitest.

vi.mock("algosdk", () => {
  const isValidAddress = vi.fn(
    (addr: unknown) => typeof addr === "string" && /^[A-Z2-7]{58}$/.test(addr as string)
  );
  const makePaymentTxnWithSuggestedParamsFromObject = vi.fn(() => ({
    signTxn: (_sk: Uint8Array) => new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  }));
  return {
    // Cover both default and named import styles used across the codebase.
    default: { isValidAddress, makePaymentTxnWithSuggestedParamsFromObject },
    isValidAddress,
    makePaymentTxnWithSuggestedParamsFromObject,
  };
});

vi.mock("../src/background/wallet-store", () => ({
  walletStore: {
    getLockState: vi.fn(() => "unlocked" as const),
    getMeta: vi.fn(),
    getActiveSecretKey: vi.fn(async () => new Uint8Array(64)),
    resetAutoLock: vi.fn(),
  },
}));

vi.mock("../src/background/chain-clients", () => ({
  getSuggestedParams: vi.fn(async () => ({
    fee: 1000n,
    flatFee: true,
    firstValid: 100n,
    lastValid: 1100n,
    genesisHash: new Uint8Array(32),
    genesisId: "voimain-v1.0",
    minFee: 1000n,
  })),
  submitTransaction: vi.fn(async () => "FAKETXID1234567890ABCD"),
}));

// Approval-handler is mocked so requestApproval resolves immediately.
// Approval-flow behaviour is independently covered by approval-handler.test.ts.
vi.mock("../src/background/approval-handler", () => ({
  requestApproval: vi.fn().mockResolvedValue(true),
}));

// ── Imports (after mock declarations) ─────────────────────────────────────────
import { walletStore } from "../src/background/wallet-store";
import { mcpResolveEnvoi } from "../src/background/mcp-client";

// ── Test constants ─────────────────────────────────────────────────────────────

/** 58-char string matching [A-Z2-7]{58} — passes our mocked isValidAddress */
const FAKE_ADDR = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** An address that is NOT 58 chars — fails mocked isValidAddress */
const INVALID_ADDR = "TOOSHORT";

const SESSION_ID = "test-mcp-session-42";

// ── Fetch stub helpers ─────────────────────────────────────────────────────────

interface MockResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  /** If string, used as-is for text(). If object, JSON-stringified. */
  body: string | object;
}

function makeResp({ status = 200, headers = {}, body }: MockResponseSpec): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => headers[k.toLowerCase()] ?? null,
    },
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

/** Replace globalThis.fetch with a queue of sequential responses. */
function stubFetch(...specs: MockResponseSpec[]): void {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const spec = specs[i++];
      if (!spec) throw new Error(`Unexpected extra fetch call (#${i})`);
      return makeResp(spec);
    })
  );
}

// ── Canned response builders ───────────────────────────────────────────────────

/** Successful MCP session-init response (call #1) */
function initResp(): MockResponseSpec {
  return {
    status: 200,
    headers: { "mcp-session-id": SESSION_ID },
    body: { jsonrpc: "2.0", id: 1, result: {} },
  };
}

/**
 * 402 payment-required response (call #2).
 * @param amount micro-VOI as a decimal string, e.g. "1000000"
 * @param payTo  recipient address (default: a valid 58-char fake)
 */
function resp402(amount: string, payTo: string = FAKE_ADDR): MockResponseSpec {
  return {
    status: 402,
    body: {
      x402Version: 1,
      error: "Payment Required",
      accepts: [
        {
          scheme: "exact",
          network: "avm:voi-mainnet",
          asset: "native",
          amount,
          payTo,
          maxTimeoutSeconds: 300,
        },
      ],
    },
  };
}

/**
 * 200 SSE response carrying a resolved enVoi address (call #2 or #3).
 * @param address  The address to embed in the tool result
 * @param asJson   If true, wraps address in { "address": "..." } JSON;
 *                 if false, returns the address as a plain string.
 */
function resolveResp(address: string, asJson = true): MockResponseSpec {
  const textContent = asJson ? JSON.stringify({ address }) : address;
  const payload = {
    jsonrpc: "2.0",
    id: 2,
    result: {
      content: [{ type: "text", text: textContent }],
      isError: false,
    },
  };
  return {
    status: 200,
    body: `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
  };
}

// ── WalletMeta factory ─────────────────────────────────────────────────────────

function makeMeta(overrides: Partial<WalletMeta> = {}): WalletMeta {
  return {
    accounts: [{ id: "acc1", name: "Alice", address: FAKE_ADDR, type: "mnemonic" }],
    activeAccountId: "acc1",
    activeChain: "voi",
    initialized: true,
    ...overrides,
  } as WalletMeta;
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(walletStore.getLockState).mockReturnValue("unlocked");
  vi.mocked(walletStore.getMeta).mockResolvedValue(makeMeta());
  vi.mocked(walletStore.getActiveSecretKey).mockResolvedValue(new Uint8Array(64));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ══════════════════════════════════════════════════════════════════════════════
// mcpResolveEnvoi — input validation (fires before any network I/O)
// ══════════════════════════════════════════════════════════════════════════════

describe("mcpResolveEnvoi — input validation", () => {
  it("throws when wallet is locked", async () => {
    vi.mocked(walletStore.getLockState).mockReturnValue("locked");
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow(
      "Wallet is locked — unlock before resolving .voi names"
    );
  });

  it("throws for an empty name", async () => {
    await expect(mcpResolveEnvoi("")).rejects.toThrow(
      "Invalid .voi name length"
    );
  });

  it("throws for a label longer than 63 characters", async () => {
    const longLabel = "a".repeat(64); // 64-char label → strip .voi → still 64
    await expect(mcpResolveEnvoi(longLabel)).rejects.toThrow(
      "Invalid .voi name length"
    );
  });

  it("throws for a 63-char label followed by .voi (label == 63 chars is valid)", async () => {
    // 63-char label is valid; stub fetch for the network calls it would make
    const label63 = "a".repeat(63);
    stubFetch(initResp(), resolveResp(FAKE_ADDR));
    // Should NOT throw on length; may throw later due to mock but not on length
    const result = await mcpResolveEnvoi(label63);
    expect(result.displayName).toBe(`${label63}.voi`);
  });

  it("throws for names containing special characters", async () => {
    await expect(mcpResolveEnvoi("shelly!")).rejects.toThrow(
      "only lowercase letters, digits, and hyphens allowed"
    );
  });

  it("throws for names containing spaces", async () => {
    await expect(mcpResolveEnvoi("hello world")).rejects.toThrow(
      "only lowercase letters, digits, and hyphens allowed"
    );
  });

  it("accepts uppercase input by silently normalising to lowercase (no rejection)", async () => {
    // mcpResolveEnvoi calls .toLowerCase() before validation: "ShellyVoi" → "shellyvoi"
    stubFetch(initResp(), resolveResp(FAKE_ADDR));
    const result = await mcpResolveEnvoi("ShellyVoi");
    expect(result.displayName).toBe("shellyvoi.voi");
  });

  it("throws for names containing non-ASCII characters that survive lowercasing", async () => {
    // "über" → .toLowerCase() → "über" which still contains ü ∉ [a-z0-9-]
    await expect(mcpResolveEnvoi("über")).rejects.toThrow(
      "only lowercase letters, digits, and hyphens allowed"
    );
  });

  it("normalises a bare label to FQDN (appends .voi)", async () => {
    stubFetch(initResp(), resolveResp(FAKE_ADDR));
    const result = await mcpResolveEnvoi("shelly");
    expect(result.displayName).toBe("shelly.voi");
  });

  it("accepts a name already ending in .voi without doubling the suffix", async () => {
    stubFetch(initResp(), resolveResp(FAKE_ADDR));
    const result = await mcpResolveEnvoi("shelly.voi");
    expect(result.displayName).toBe("shelly.voi");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-01: Spending cap enforcement
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-01: spending cap enforcement", () => {
  // Default cap is 10 VOI = 10_000_000 µVOI

  it("throws when the 402 amount exceeds the default 10 VOI cap", async () => {
    stubFetch(initResp(), resp402("10000001")); // 10.000001 VOI > cap
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow(
      "exceeds spending cap"
    );
  });

  it("does not throw when the 402 amount exactly equals the default cap", async () => {
    stubFetch(initResp(), resp402("10000000"), resolveResp(FAKE_ADDR)); // exactly 10 VOI
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
  });

  it("respects a custom spending cap from meta.spendingCaps.nativeMicrounits", async () => {
    vi.mocked(walletStore.getMeta).mockResolvedValue(
      makeMeta({ spendingCaps: { nativeMicrounits: 500_000, asaMicrounits: 0 } })
    );
    stubFetch(initResp(), resp402("500001")); // 0.500001 VOI > 0.5 VOI cap
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow(
      "exceeds spending cap"
    );
  });

  it("allows payment when amount is within a custom cap", async () => {
    vi.mocked(walletStore.getMeta).mockResolvedValue(
      makeMeta({ spendingCaps: { nativeMicrounits: 2_000_000, asaMicrounits: 0 } })
    );
    stubFetch(initResp(), resp402("1000000"), resolveResp(FAKE_ADDR)); // 1 VOI ≤ 2 VOI cap
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
  });

  it("throws for a zero amount in the 402 response", async () => {
    stubFetch(initResp(), resp402("0"));
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow(
      "Invalid payment amount"
    );
  });

  it("throws for a negative amount string in the 402 response", async () => {
    stubFetch(initResp(), resp402("-1"));
    // BigInt("-1") is -1n which is ≤ 0n
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow(
      "Invalid payment amount"
    );
  });

  it("throws for a WalletConnect account (cannot auto-pay)", async () => {
    vi.mocked(walletStore.getMeta).mockResolvedValue(
      makeMeta({
        accounts: [{ id: "acc1", name: "WC", address: FAKE_ADDR, type: "walletconnect" }],
        activeAccountId: "acc1",
      })
    );
    stubFetch(initResp(), resp402("1000000"));
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow(
      "WalletConnect accounts cannot auto-pay"
    );
  });

  it("throws for an invalid recipient address in the 402 response", async () => {
    stubFetch(initResp(), resp402("1000000", "NOT_A_VALID_ADDRESS_AT_ALL"));
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow(
      "Invalid x402 payment recipient"
    );
  });

  it("throws 'Wallet locked during approval' when wallet locks between approval and payVoi (MED-04)", async () => {
    // Arrange: initial lock check passes; MED-04 post-approval re-check fails.
    // mockReturnValueOnce overrides take precedence over the beforeEach default.
    vi.mocked(walletStore.getLockState)
      .mockReturnValueOnce("unlocked")  // call 1 — mcpResolveEnvoi() initial guard
      .mockReturnValueOnce("locked");   // call 2 — callTool() post-approval re-check
    stubFetch(initResp(), resp402("1000000")); // init + 402; no third fetch because we throw
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow("Wallet locked during approval");
  });

  it("happy path: amount within default cap → payment succeeds and address returned", async () => {
    stubFetch(
      initResp(),          // initSession
      resp402("1000000"),  // callTool first attempt → 402
      resolveResp(FAKE_ADDR) // callTool retry → 200 with resolved address
    );
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
    expect(result.displayName).toBe("shelly.voi");
  });

  it("happy path: no 402 (first tools/call returns 200 immediately)", async () => {
    stubFetch(
      initResp(),            // initSession
      resolveResp(FAKE_ADDR) // callTool → 200 directly (no payment needed)
    );
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
    // fetch should only have been called twice (init + one tools/call)
    expect(vi.mocked(globalThis.fetch as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-02: SSE response shape parsing
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-02: SSE response shape parsing", () => {
  /** Convenience: build the SSE text for a tools/call result directly. */
  function sseText(resultPayload: object, eventType?: string): MockResponseSpec {
    const dataLine = `data: ${JSON.stringify(resultPayload)}`;
    const body = eventType
      ? `event: ${eventType}\n${dataLine}\n\n`
      : `${dataLine}\n\n`;
    return { status: 200, body };
  }

  function toolResult(textContent: string): object {
    return {
      jsonrpc: "2.0",
      id: 2,
      result: { content: [{ type: "text", text: textContent }], isError: false },
    };
  }

  // ── event: message selection ───────────────────────────────────────────────

  it("extracts data from an 'event: message' SSE event", async () => {
    stubFetch(initResp(), sseText(toolResult(JSON.stringify({ address: FAKE_ADDR })), "message"));
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
  });

  it("falls back to the first data: line when no event: type is present", async () => {
    stubFetch(initResp(), sseText(toolResult(JSON.stringify({ address: FAKE_ADDR }))));
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
  });

  it("prefers event: message data over an earlier non-message event's data", async () => {
    // SSE stream: first a 'partial' event (should be ignored), then a 'message' event (should win)
    const partialResult = toolResult(JSON.stringify({ address: "X".repeat(58) }));
    const finalResult = toolResult(JSON.stringify({ address: FAKE_ADDR }));
    const body =
      `event: partial\ndata: ${JSON.stringify(partialResult)}\n\n` +
      `event: message\ndata: ${JSON.stringify(finalResult)}\n\n`;
    stubFetch(initResp(), { status: 200, body });
    const result = await mcpResolveEnvoi("shelly");
    // Must return the message-event address, not the partial-event address
    expect(result.address).toBe(FAKE_ADDR);
  });

  it("skips a malformed (non-JSON) data line and falls back to the next valid one", async () => {
    // First data line is malformed JSON; second is the real result
    const realResult = toolResult(JSON.stringify({ address: FAKE_ADDR }));
    const body =
      `data: {this is not json}\n` +
      `event: message\ndata: ${JSON.stringify(realResult)}\n\n`;
    stubFetch(initResp(), { status: 200, body });
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
  });

  it("throws 'Empty response' when the entire SSE body has no parseable data", async () => {
    const body = `data: {bad json\ndata: also bad\n\n`;
    stubFetch(initResp(), { status: 200, body });
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow("Empty response");
  });

  // ── Address extraction shapes ──────────────────────────────────────────────

  it("resolves { address: '...' } JSON shape", async () => {
    stubFetch(initResp(), resolveResp(FAKE_ADDR, true)); // asJson = true → { address }
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
  });

  it("resolves { result: { address: '...' } } nested JSON shape", async () => {
    const textContent = JSON.stringify({ result: { address: FAKE_ADDR } });
    const payload = toolResult(textContent);
    stubFetch(initResp(), sseText(payload, "message"));
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
  });

  it("resolves { data: { address: '...' } } nested JSON shape", async () => {
    const textContent = JSON.stringify({ data: { address: FAKE_ADDR } });
    const payload = toolResult(textContent);
    stubFetch(initResp(), sseText(payload, "message"));
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
  });

  it("resolves a plain address string (not wrapped in JSON)", async () => {
    stubFetch(initResp(), resolveResp(FAKE_ADDR, false)); // asJson = false → plain address
    const result = await mcpResolveEnvoi("shelly");
    expect(result.address).toBe(FAKE_ADDR);
  });

  it("throws 'Name not found' when the JSON response contains no address field", async () => {
    const textContent = JSON.stringify({ some_other_key: "irrelevant" });
    stubFetch(initResp(), sseText(toolResult(textContent), "message"));
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow("Name not found");
  });

  it("throws 'Name not found' when the text content is an empty string", async () => {
    stubFetch(initResp(), sseText(toolResult(""), "message"));
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow(
      /returned no content|Name not found/
    );
  });

  it("throws 'Invalid response from name service' when the returned address fails validation", async () => {
    // INVALID_ADDR is not 58 chars → our mock isValidAddress returns false
    const textContent = JSON.stringify({ address: INVALID_ADDR });
    stubFetch(initResp(), sseText(toolResult(textContent), "message"));
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow(
      "Invalid response from name service"
    );
  });

  it("throws 'MCP error' when the server returns a JSON-RPC error object", async () => {
    const errorPayload = { jsonrpc: "2.0", id: 2, error: { code: -32001, message: "not found" } };
    stubFetch(initResp(), sseText(errorPayload, "message"));
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow("MCP error: not found");
  });

  it("throws when the tool result itself sets isError: true", async () => {
    const errContent = { jsonrpc: "2.0", id: 2, result: {
      content: [{ type: "text", text: "Name does not exist" }], isError: true,
    }};
    stubFetch(initResp(), sseText(errContent, "message"));
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow("Name does not exist");
  });

  // ── MCP session init failures ──────────────────────────────────────────────

  it("throws 'MCP init failed' when session init returns a non-2xx status", async () => {
    stubFetch({ status: 503, body: "Service Unavailable" });
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow("MCP init failed with status 503");
  });

  it("throws when session init returns 200 but no mcp-session-id header", async () => {
    stubFetch({ status: 200, body: {} }); // no mcp-session-id header
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow(
      "MCP server did not return a session ID"
    );
  });

  it("throws 'MCP tool call failed' when the tools/call retry returns a non-2xx status", async () => {
    stubFetch(initResp(), resp402("1000000"), { status: 500, body: "Internal Server Error" });
    await expect(mcpResolveEnvoi("shelly")).rejects.toThrow("MCP tool call failed with status 500");
  });
});
