/**
 * Tests for src/background/message-handler.ts
 *
 * AUTO-03 — VOI_RESOLVE_NAME handler guards:
 *   - Rejects when active chain is not "voi"
 *   - Rejects when wallet is locked
 *   - Delegates to mcpResolveEnvoi with the correct name on happy path
 *   - Propagates mcpResolveEnvoi errors as { ok: false, error }
 *   - Returns { ok: true, data: { address, displayName } } on success
 *
 * Strategy:
 *   The Chrome runtime is stubbed globally before the module is imported.
 *   After calling registerMessageHandler(), the captured onMessage listener
 *   is invoked directly — avoiding the need to export internal helpers.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import type { BgRequest } from "../src/shared/types/messages";
import type { WalletMeta } from "../src/shared/types/wallet";

// ── Hoisted module mocks ───────────────────────────────────────────────────────

vi.mock("algosdk", () => {
  const isValidAddress = vi.fn((addr: unknown) => typeof addr === "string" && addr.length === 58);
  return {
    default: { isValidAddress, decodeUnsignedTransaction: vi.fn(), signBytes: vi.fn() },
    isValidAddress,
    decodeUnsignedTransaction: vi.fn(),
    signBytes: vi.fn(),
  };
});

vi.mock("../src/background/wallet-store", () => ({
  walletStore: {
    getLockState: vi.fn(() => "unlocked" as const),
    getMeta: vi.fn(),
    getActiveSecretKey: vi.fn(async () => new Uint8Array(64)),
    isInitialized: vi.fn(async () => true),
    lock: vi.fn(),
    unlock: vi.fn(),
    resetAutoLock: vi.fn(),
    initialize: vi.fn(),
    createAccount: vi.fn(),
    importAccount: vi.fn(),
    removeAccount: vi.fn(),
    renameAccount: vi.fn(),
    setActiveAccount: vi.fn(),
    setActiveChain: vi.fn(),
    addWCAccount: vi.fn(),
    addConnectedSite: vi.fn(),
    removeConnectedSite: vi.fn(),
    getConnectedAddresses: vi.fn(),
  },
}));

vi.mock("../src/background/chain-clients", () => ({
  getAccountState: vi.fn(),
  getSuggestedParams: vi.fn(),
  submitTransaction: vi.fn(),
  submitTransactionGroup: vi.fn(),
  waitForConfirmation: vi.fn(),
  waitForIndexed: vi.fn(),
  hasOptedIn: vi.fn(),
}));

vi.mock("../src/background/x402-handler", () => ({
  handleX402: vi.fn(),
  buildAndSignPayment: vi.fn(),
  buildPaymentTxnForWC: vi.fn(),
  getPendingRequest: vi.fn(),
  clearPendingRequest: vi.fn(),
  resolveChain: vi.fn(),
}));

vi.mock("../src/background/approval-handler", () => ({
  requestApproval: vi.fn().mockResolvedValue(true),
  countPendingByOrigin: vi.fn(() => 0),
}));

vi.mock("../src/background/mcp-client", () => ({
  mcpResolveEnvoi: vi.fn(),
}));

// ── Imports (after mock declarations) ─────────────────────────────────────────
import algosdk from "algosdk";
import { walletStore } from "../src/background/wallet-store";
import { buildAndSignPayment, getPendingRequest, resolveChain } from "../src/background/x402-handler";
import { requestApproval, countPendingByOrigin } from "../src/background/approval-handler";
import { mcpResolveEnvoi } from "../src/background/mcp-client";
import { submitTransaction } from "../src/background/chain-clients";
import type { PendingX402Request } from "../src/shared/types/x402";

// ── Chrome global stub ─────────────────────────────────────────────────────────
// Must be set up before registerMessageHandler() is called.

// Capture the onMessage listener registered by the module.
let capturedListener: (
  msg: BgRequest,
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void
) => boolean | void;

const mockChrome = {
  runtime: {
    onMessage: {
      addListener: vi.fn((cb) => {
        capturedListener = cb;
      }),
    },
    onSuspend: { addListener: vi.fn() },
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
  tabs: {
    query: vi.fn(),
    sendMessage: vi.fn(),
    get: vi.fn().mockRejectedValue(new Error("Tab not found")), // safe default; tests override as needed
  },
};

// ── Module registration ────────────────────────────────────────────────────────

beforeAll(async () => {
  // Stub chrome before importing or registering anything that touches it.
  vi.stubGlobal("chrome", mockChrome);

  const { registerMessageHandler } = await import(
    "../src/background/message-handler"
  );
  registerMessageHandler();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

const FAKE_ADDR = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 58 A's

/** Minimal PendingX402Request for x402 handler tests. tabId=1 matches mock sender. */
const FAKE_X402_REQ: PendingX402Request = {
  id: "internal-bg-req-id",
  tabId: 1,
  url: "https://example.com/resource",
  method: "GET",
  headers: {},
  paymentRequirements: {
    scheme: "exact",
    network: "voi-mainnet",
    maxAmountRequired: "1000000",
    resource: "https://example.com/resource",
    description: "Test payment",
    mimeType: "application/json",
    payTo: FAKE_ADDR,
    maxTimeoutSeconds: 60,
    asset: "0",
  },
  allRequirements: [],
  timestamp: 0,
};

function makeMeta(overrides: Partial<WalletMeta> = {}): WalletMeta {
  return {
    accounts: [{ id: "acc1", name: "Alice", address: FAKE_ADDR, type: "mnemonic" }],
    activeAccountId: "acc1",
    activeChain: "voi",
    initialized: true,
    ...overrides,
  } as WalletMeta;
}

/**
 * Send a message through the registered Chrome runtime listener and await
 * the sendResponse callback. Simulates the real Chrome extension message flow.
 */
function sendMessage(
  msg: BgRequest,
  senderOverrides: Partial<chrome.runtime.MessageSender> = {}
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  return new Promise((resolve, reject) => {
    if (!capturedListener) {
      reject(new Error("registerMessageHandler() was not called or listener not captured"));
      return;
    }
    const sender: chrome.runtime.MessageSender = {
      tab: { id: 1 } as chrome.runtime.MessageSender["tab"],
      url: "chrome-extension://fakeextensionid/popup.html",
      ...senderOverrides,
    };
    capturedListener(msg, sender, (response) => {
      resolve(response as { ok: boolean; data?: unknown; error?: string });
    });
  });
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(walletStore.getLockState).mockReturnValue("unlocked");
  vi.mocked(walletStore.getMeta).mockResolvedValue(makeMeta());
});

afterEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-03: VOI_RESOLVE_NAME handler guards
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-03: VOI_RESOLVE_NAME handler", () => {
  const RESOLVE_MSG = { type: "VOI_RESOLVE_NAME", name: "shelly" } as BgRequest;

  // ── Chain guard ────────────────────────────────────────────────────────────

  it("rejects with an error when the active chain is not 'voi'", async () => {
    vi.mocked(walletStore.getMeta).mockResolvedValue(
      makeMeta({ activeChain: "algorand" })
    );
    const resp = await sendMessage(RESOLVE_MSG);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Name service is only available on the Voi chain");
  });

  it("does not call mcpResolveEnvoi when the chain guard fires", async () => {
    vi.mocked(walletStore.getMeta).mockResolvedValue(
      makeMeta({ activeChain: "algorand" })
    );
    await sendMessage(RESOLVE_MSG);
    expect(vi.mocked(mcpResolveEnvoi)).not.toHaveBeenCalled();
  });

  // ── Lock guard ─────────────────────────────────────────────────────────────

  it("rejects with an error when the wallet is locked", async () => {
    vi.mocked(walletStore.getLockState).mockReturnValue("locked");
    const resp = await sendMessage(RESOLVE_MSG);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Wallet is locked");
  });

  it("does not call mcpResolveEnvoi when the lock guard fires", async () => {
    vi.mocked(walletStore.getLockState).mockReturnValue("locked");
    await sendMessage(RESOLVE_MSG);
    expect(vi.mocked(mcpResolveEnvoi)).not.toHaveBeenCalled();
  });

  // ── Happy path ─────────────────────────────────────────────────────────────

  it("calls mcpResolveEnvoi with the exact name from the message", async () => {
    vi.mocked(mcpResolveEnvoi).mockResolvedValue({
      address: FAKE_ADDR,
      displayName: "shelly.voi",
    });
    await sendMessage(RESOLVE_MSG);
    expect(vi.mocked(mcpResolveEnvoi)).toHaveBeenCalledWith("shelly");
  });

  it("returns { ok: true, data: { address, displayName } } on success", async () => {
    vi.mocked(mcpResolveEnvoi).mockResolvedValue({
      address: FAKE_ADDR,
      displayName: "shelly.voi",
    });
    const resp = await sendMessage(RESOLVE_MSG);
    expect(resp.ok).toBe(true);
    expect(resp.data).toEqual({ address: FAKE_ADDR, displayName: "shelly.voi" });
  });

  it("forwards the error from mcpResolveEnvoi as { ok: false, error }", async () => {
    vi.mocked(mcpResolveEnvoi).mockRejectedValue(new Error("Name not found"));
    const resp = await sendMessage(RESOLVE_MSG);
    expect(resp.ok).toBe(false);
    expect(resp.error).toBe("Name not found");
  });

  it("propagates spending-cap errors from mcpResolveEnvoi", async () => {
    vi.mocked(mcpResolveEnvoi).mockRejectedValue(
      new Error("Resolution fee 20000000 µVOI exceeds spending cap of 10000000 µVOI.")
    );
    const resp = await sendMessage(RESOLVE_MSG);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("exceeds spending cap");
  });

  // ── Unknown message type fallthrough ──────────────────────────────────────

  it("returns { ok: false, error: 'Unknown message type' } for unrecognised types", async () => {
    const resp = await sendMessage({ type: "TOTALLY_UNKNOWN_TYPE" } as unknown as BgRequest);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Unknown message type");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-04: X402_APPROVE security guards (CRIT-01)
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-04: X402_APPROVE security guards", () => {
  const APPROVE_MSG = { type: "X402_APPROVE", requestId: "bg-req-1" } as BgRequest;

  it("returns error 'Pending request not found' when requestId is unknown", async () => {
    vi.mocked(getPendingRequest).mockReturnValue(null);
    const resp = await sendMessage(APPROVE_MSG);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Pending request not found");
  });

  it("returns error 'Wallet locked during approval' when wallet locked after request found", async () => {
    vi.mocked(getPendingRequest).mockReturnValue(FAKE_X402_REQ);
    vi.mocked(walletStore.getLockState).mockReturnValue("locked");
    const resp = await sendMessage(APPROVE_MSG);
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Wallet locked during approval");
  });

  it("calls resetAutoLock when wallet is unlocked and request exists", async () => {
    vi.mocked(getPendingRequest).mockReturnValue(FAKE_X402_REQ);
    vi.mocked(buildAndSignPayment).mockResolvedValue({ paymentHeader: "ph", txId: "tx1" });
    await sendMessage(APPROVE_MSG);
    expect(walletStore.resetAutoLock).toHaveBeenCalled();
  });

  it("does NOT call buildAndSignPayment when wallet is locked after approval", async () => {
    vi.mocked(getPendingRequest).mockReturnValue(FAKE_X402_REQ);
    vi.mocked(walletStore.getLockState).mockReturnValue("locked");
    await sendMessage(APPROVE_MSG);
    expect(vi.mocked(buildAndSignPayment)).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-05: ARC27_SIGN_BYTES signer validation (MED-03)
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-05: ARC27_SIGN_BYTES signer validation", () => {
  // Different 58-char address — passes algosdk.isValidAddress but not the signer check.
  const WRONG_SIGNER = "B".repeat(58);

  beforeEach(() => {
    // Ensure the requesting site appears connected (non-empty address list).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(walletStore.getConnectedAddresses as any).mockResolvedValue([FAKE_ADDR]);
    // Make algosdk.signBytes return a Uint8Array so btoa(String.fromCharCode(...)) works.
    vi.mocked(algosdk.signBytes).mockReturnValue(new Uint8Array(0));
  });

  it("throws 'Signer address does not match' when msg.signer differs from active account", async () => {
    const resp = await sendMessage(
      { type: "ARC27_SIGN_BYTES", data: btoa("hello"), signer: WRONG_SIGNER } as BgRequest,
      { url: "https://example.com" }
    );
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Signer address does not match");
  });

  it("proceeds to requestApproval when msg.signer matches active account", async () => {
    const resp = await sendMessage(
      { type: "ARC27_SIGN_BYTES", data: btoa("hello"), signer: FAKE_ADDR } as BgRequest,
      { url: "https://example.com" }
    );
    expect(vi.mocked(requestApproval)).toHaveBeenCalled();
    expect(resp.ok).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-06: X402_RESULT uses inpageRequestId for tab routing (HIGH-04)
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-06: X402_RESULT tab message routing", () => {
  it("X402_APPROVE sends X402_RESULT with req.inpageRequestId when set", async () => {
    const req = { ...FAKE_X402_REQ, inpageRequestId: "inpage-123" };
    vi.mocked(getPendingRequest).mockReturnValue(req);
    vi.mocked(buildAndSignPayment).mockResolvedValue({ paymentHeader: "ph", txId: "tx1" });

    await sendMessage({ type: "X402_APPROVE", requestId: "bg-req-1" } as BgRequest);

    expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
      req.tabId,
      expect.objectContaining({ type: "X402_RESULT", requestId: "inpage-123" })
    );
  });

  it("X402_APPROVE falls back to req.id when inpageRequestId is absent", async () => {
    const req = { ...FAKE_X402_REQ, inpageRequestId: undefined };
    vi.mocked(getPendingRequest).mockReturnValue(req);
    vi.mocked(buildAndSignPayment).mockResolvedValue({ paymentHeader: "ph", txId: "tx1" });

    await sendMessage({ type: "X402_APPROVE", requestId: "bg-req-1" } as BgRequest);

    expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
      req.tabId,
      expect.objectContaining({ type: "X402_RESULT", requestId: FAKE_X402_REQ.id })
    );
  });

  it("X402_WC_SIGNED sends X402_RESULT with req.inpageRequestId when set", async () => {
    const req = { ...FAKE_X402_REQ, inpageRequestId: "inpage-wc-456" };
    vi.mocked(getPendingRequest).mockReturnValue(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(resolveChain).mockReturnValue("voi" as any);

    await sendMessage({
      type: "X402_WC_SIGNED",
      requestId: "bg-req-2",
      signedTxnB64: btoa("fakesigned"),
    } as BgRequest);

    expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
      req.tabId,
      expect.objectContaining({ type: "X402_RESULT", requestId: "inpage-wc-456" })
    );
  });

  it("X402_REJECT sends X402_RESULT with req.inpageRequestId when set", async () => {
    const req = { ...FAKE_X402_REQ, inpageRequestId: "inpage-reject-789" };
    vi.mocked(getPendingRequest).mockReturnValue(req);

    await sendMessage({ type: "X402_REJECT", requestId: "bg-req-3" } as BgRequest);

    expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
      req.tabId,
      expect.objectContaining({ type: "X402_RESULT", requestId: "inpage-reject-789" })
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-07: ARC27_ENABLE account validation (MED-01)
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-07: ARC27_ENABLE account validation", () => {
  const UNKNOWN_ADDR = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"; // 58 B's

  it("throws 'Requested accounts not found in wallet' when msg.accounts contains an unknown address", async () => {
    // FAKE_ADDR is in wallet; UNKNOWN_ADDR is not
    vi.mocked(walletStore.getMeta).mockResolvedValue(makeMeta());

    const resp = await sendMessage(
      { type: "ARC27_ENABLE", accounts: [UNKNOWN_ADDR] } as BgRequest,
      { url: "https://example.com/page" }
    );

    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Requested accounts not found in wallet");
    expect(vi.mocked(walletStore.addConnectedSite)).not.toHaveBeenCalled();
  });

  it("calls addConnectedSite when msg.accounts contains only known addresses", async () => {
    vi.mocked(walletStore.getMeta).mockResolvedValue(makeMeta());

    const resp = await sendMessage(
      { type: "ARC27_ENABLE", accounts: [FAKE_ADDR] } as BgRequest,
      { url: "https://example.com/page" }
    );

    expect(resp.ok).toBe(true);
    expect(vi.mocked(walletStore.addConnectedSite)).toHaveBeenCalledWith(
      "https://example.com",
      [FAKE_ADDR]
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-08: ARC27 per-origin signing cap (INFO-05)
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-08: ARC27 per-origin signing cap", () => {
  beforeEach(() => {
    vi.mocked(walletStore.getConnectedAddresses).mockResolvedValue([FAKE_ADDR]);
  });

  it("ARC27_SIGN_TXNS: throws 'Too many pending signing requests' when cap is reached", async () => {
    vi.mocked(countPendingByOrigin).mockReturnValue(5);

    const resp = await sendMessage(
      { type: "ARC27_SIGN_TXNS", txns: [] } as BgRequest,
      { url: "https://example.com/dapp" }
    );

    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Too many pending signing requests from this site");
    // Cap fires before approval queue — requestApproval must not be called
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
  });

  it("ARC27_SIGN_BYTES: throws 'Too many pending signing requests' when cap is reached", async () => {
    vi.mocked(countPendingByOrigin).mockReturnValue(5);
    // signer must match active account so signer-validation passes first
    vi.mocked(walletStore.getMeta).mockResolvedValue(makeMeta());

    const resp = await sendMessage(
      { type: "ARC27_SIGN_BYTES", data: btoa("hello"), signer: FAKE_ADDR } as BgRequest,
      { url: "https://example.com/dapp" }
    );

    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Too many pending signing requests from this site");
    expect(vi.mocked(requestApproval)).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-09: CHAIN_SEND_ASSET decimals bounds check (M2)
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-09: CHAIN_SEND_ASSET decimals bounds check", () => {
  const BASE_MSG = {
    type: "CHAIN_SEND_ASSET",
    to: FAKE_ADDR,
    amount: "1",
    assetId: 12345,
    decimals: 6,
    chain: "algorand",
  } as BgRequest;

  it("rejects when decimals is negative", async () => {
    const resp = await sendMessage(
      { ...BASE_MSG, decimals: -1 } as unknown as BgRequest
    );
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Invalid decimals");
  });

  it("rejects when decimals exceeds 19", async () => {
    const resp = await sendMessage(
      { ...BASE_MSG, decimals: 20 } as unknown as BgRequest
    );
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Invalid decimals");
  });

  it("rejects when decimals is not an integer", async () => {
    const resp = await sendMessage(
      { ...BASE_MSG, decimals: 6.5 } as unknown as BgRequest
    );
    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Invalid decimals");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-06 (extended): X402_WC_SIGNED sends txId in X402_RESULT
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-06 (extended): X402_WC_SIGNED txId-based retry contract", () => {
  it("sends X402_RESULT with txId captured from submitTransaction", async () => {
    vi.mocked(submitTransaction).mockResolvedValue("WC_TXID_ABC123");
    const req = { ...FAKE_X402_REQ, inpageRequestId: "inpage-wc-txid" };
    vi.mocked(getPendingRequest).mockReturnValue(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(resolveChain).mockReturnValue("voi" as any);

    await sendMessage({
      type: "X402_WC_SIGNED",
      requestId: "bg-req-txid",
      signedTxnB64: btoa("fakesigned"),
    } as BgRequest);

    expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
      req.tabId,
      expect.objectContaining({ type: "X402_RESULT", txId: "WC_TXID_ABC123" })
    );
  });

  it("X402_WC_SIGNED returns { paymentHeader, txId } to caller", async () => {
    vi.mocked(submitTransaction).mockResolvedValue("WC_TXID_RETURN");
    const req = { ...FAKE_X402_REQ, inpageRequestId: "inpage-wc-ret" };
    vi.mocked(getPendingRequest).mockReturnValue(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(resolveChain).mockReturnValue("voi" as any);

    const resp = await sendMessage({
      type: "X402_WC_SIGNED",
      requestId: "bg-req-ret",
      signedTxnB64: btoa("fakesigned"),
    } as BgRequest);

    expect(resp.ok).toBe(true);
    expect((resp.data as { txId?: string }).txId).toBe("WC_TXID_RETURN");
  });

  it("X402_WC_SIGNED fails closed when active account cannot be resolved for payer", async () => {
    vi.mocked(submitTransaction).mockResolvedValue("WC_TXID_PAYER_ERR");
    vi.mocked(getPendingRequest).mockReturnValue(FAKE_X402_REQ);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(resolveChain).mockReturnValue("voi" as any);
    // No account matches activeAccountId
    vi.mocked(walletStore.getMeta).mockResolvedValue(
      makeMeta({ activeAccountId: "nonexistent" })
    );

    const resp = await sendMessage({
      type: "X402_WC_SIGNED",
      requestId: "bg-req-payer-err",
      signedTxnB64: btoa("fakesigned"),
    } as BgRequest);

    expect(resp.ok).toBe(false);
    expect(resp.error).toMatch("Cannot determine payer address");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-14: X402_APPROVE vault path sends txId in X402_RESULT
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-14: X402_APPROVE vault path sends txId in X402_RESULT", () => {
  it("sends X402_RESULT with txId from buildAndSignPayment", async () => {
    const req = { ...FAKE_X402_REQ, inpageRequestId: "inpage-vault-txid" };
    vi.mocked(getPendingRequest).mockReturnValue(req);
    vi.mocked(buildAndSignPayment).mockResolvedValue({
      paymentHeader: "ph-vault",
      txId: "VAULT_TXID_XYZ",
    });

    await sendMessage({ type: "X402_APPROVE", requestId: "bg-vault-1" } as BgRequest);

    expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
      req.tabId,
      expect.objectContaining({ type: "X402_RESULT", txId: "VAULT_TXID_XYZ" })
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-10: ARC27_DISCONNECT fail-closed (H1 Hardening IV)
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-10: ARC27_DISCONNECT fail-closed (H1)", () => {
  const DISCONNECT_MSG = { type: "ARC27_DISCONNECT" } as BgRequest;

  it("returns no-op success and does NOT call removeConnectedSite when sender.url is absent", async () => {
    // Simulate a message from a context that has no URL (e.g. direct runtime message
    // without a content-script sender.url).
    const resp = await sendMessage(DISCONNECT_MSG, { url: undefined });

    expect(resp.ok).toBe(true);
    expect(vi.mocked(walletStore.removeConnectedSite)).not.toHaveBeenCalled();
  });

  it("calls removeConnectedSite with the correct origin when sender.url is present", async () => {
    const resp = await sendMessage(
      DISCONNECT_MSG,
      { url: "https://app.tinyman.org/swap" }
    );

    expect(resp.ok).toBe(true);
    expect(vi.mocked(walletStore.removeConnectedSite)).toHaveBeenCalledWith(
      "https://app.tinyman.org"
    );
  });
});
