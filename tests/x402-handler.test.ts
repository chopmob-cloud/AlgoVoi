/**
 * Tests for src/background/x402-handler.ts
 *
 * AUTO-11: parsePaymentRequired — v1 spec, legacy bare format, invalid inputs
 * AUTO-12: pickAVMOption — chain selection, fallback, no match
 * AUTO-13: buildAndSignPayment — new txId + payer proof payload (production contract)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PendingX402Request } from "../src/shared/types/x402";
import type { WalletMeta } from "../src/shared/types/wallet";

// ── Module mocks ───────────────────────────────────────────────────────────────

const MOCK_TX_ID = "TXID1234567890ABCDEF";
const MOCK_SIGNED_BYTES = new Uint8Array([1, 2, 3]);

vi.mock("algosdk", () => {
  const mockTxn = {
    signTxn: vi.fn(() => MOCK_SIGNED_BYTES),
    txID: vi.fn(() => MOCK_TX_ID),
    toByte: vi.fn(() => new Uint8Array([4, 5, 6])),
  };
  const isValidAddress = vi.fn(
    (addr: unknown) => typeof addr === "string" && addr.length === 58
  );
  return {
    default: {
      isValidAddress,
      makePaymentTxnWithSuggestedParamsFromObject: vi.fn(() => mockTxn),
      makeAssetTransferTxnWithSuggestedParamsFromObject: vi.fn(() => mockTxn),
      decodeUnsignedTransaction: vi.fn(),
      signBytes: vi.fn(),
    },
    isValidAddress,
    makePaymentTxnWithSuggestedParamsFromObject: vi.fn(() => mockTxn),
    makeAssetTransferTxnWithSuggestedParamsFromObject: vi.fn(() => mockTxn),
    decodeUnsignedTransaction: vi.fn(),
    signBytes: vi.fn(),
  };
});

vi.mock("../src/background/wallet-store", () => ({
  walletStore: {
    getLockState: vi.fn(() => "unlocked" as const),
    getMeta: vi.fn(),
    getActiveSecretKey: vi.fn(async () => new Uint8Array(64)),
  },
}));

vi.mock("../src/background/chain-clients", () => ({
  getSuggestedParams: vi.fn(async () => ({
    genesisHash: new Uint8Array(32),
    minFee: 1000,
  })),
  hasOptedIn: vi.fn(async () => true),
  submitTransaction: vi.fn(async () => "SUBMITTED_TXID_XYZ"),
  submitTransactionGroup: vi.fn(async () => "SUBMITTED_GROUP_XYZ"),
  waitForConfirmation: vi.fn(async () => ({})),
  waitForIndexed: vi.fn(async () => true),
  getAccountState: vi.fn(async () => ({
    balance: 100_000_000n,
    minBalance: 100_000n,
  })),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────────

import {
  parsePaymentRequired,
  pickAVMOption,
  buildAndSignPayment,
} from "../src/background/x402-handler";
import { walletStore } from "../src/background/wallet-store";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const FAKE_ADDR = "A".repeat(58);

function makeMeta(overrides: Partial<WalletMeta> = {}): WalletMeta {
  return {
    accounts: [{ id: "acc1", name: "Alice", address: FAKE_ADDR, type: "mnemonic" }],
    activeAccountId: "acc1",
    activeChain: "algorand",
    initialized: true,
    ...overrides,
  } as WalletMeta;
}

const BASE_OPT = {
  scheme: "exact" as const,
  maxAmountRequired: "1000",
  resource: "https://example.com",
  description: "Test",
  mimeType: "text/plain",
  payTo: FAKE_ADDR,
  maxTimeoutSeconds: 30,
  asset: "0",
};

const FAKE_REQ: PendingX402Request = {
  id: "bg-test-id",
  tabId: 1,
  url: "https://example.com/resource",
  method: "GET",
  headers: {},
  paymentRequirements: {
    ...BASE_OPT,
    network: "algorand-mainnet",
    maxAmountRequired: "1000000",
  },
  allRequirements: [],
  timestamp: 0,
};

beforeEach(() => {
  vi.mocked(walletStore.getMeta).mockResolvedValue(makeMeta());
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-11: parsePaymentRequired
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-11: parsePaymentRequired", () => {
  it("returns a PaymentRequired for valid v1 spec with accepts[]", () => {
    const pr = {
      x402Version: 1,
      error: "Payment required",
      accepts: [{ ...BASE_OPT, network: "algorand-mainnet" }],
    };
    const result = parsePaymentRequired(btoa(JSON.stringify(pr)));
    expect(result).not.toBeNull();
    expect(result?.x402Version).toBe(1);
    expect(result?.accepts).toHaveLength(1);
  });

  it("wraps legacy bare PaymentRequirements (scheme+network, no accepts) in accepts[]", () => {
    const bare = { ...BASE_OPT, network: "voi-mainnet" };
    const result = parsePaymentRequired(btoa(JSON.stringify(bare)));
    expect(result).not.toBeNull();
    expect(result?.accepts).toHaveLength(1);
    expect(result?.accepts[0].scheme).toBe("exact");
    expect(result?.accepts[0].network).toBe("voi-mainnet");
  });

  it("returns null for invalid base64", () => {
    expect(parsePaymentRequired("!!!not-base64!!!")).toBeNull();
  });

  it("returns null for valid base64 but invalid JSON", () => {
    expect(parsePaymentRequired(btoa("{not json}"))).toBeNull();
  });

  it("returns null for JSON missing both accepts[] and scheme", () => {
    const b64 = btoa(JSON.stringify({ x402Version: 1, error: "Payment required" }));
    expect(parsePaymentRequired(b64)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parsePaymentRequired("")).toBeNull();
  });

  it("accepts a v1 PaymentRequired with multiple entries in accepts[]", () => {
    const pr = {
      x402Version: 1,
      error: "Pay",
      accepts: [
        { ...BASE_OPT, network: "algorand-mainnet" },
        { ...BASE_OPT, network: "voi-mainnet" },
      ],
    };
    const result = parsePaymentRequired(btoa(JSON.stringify(pr)));
    expect(result?.accepts).toHaveLength(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-12: pickAVMOption
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-12: pickAVMOption", () => {
  const algoOpt = { ...BASE_OPT, network: "algorand-mainnet" };
  const voiOpt  = { ...BASE_OPT, network: "voi-mainnet" };
  const evmOpt  = { ...BASE_OPT, network: "eip155:8453" };

  it("returns the first AVM option when no preferred chain is given", () => {
    expect(pickAVMOption([algoOpt, voiOpt])?.network).toBe("algorand-mainnet");
  });

  it("returns the preferred chain option when it is present", () => {
    expect(pickAVMOption([algoOpt, voiOpt], "voi")?.network).toBe("voi-mainnet");
  });

  it("falls back to the first AVM option when preferred chain is absent", () => {
    expect(pickAVMOption([voiOpt], "algorand")?.network).toBe("voi-mainnet");
  });

  it("returns null when accepts contains only non-AVM options", () => {
    expect(pickAVMOption([evmOpt])).toBeNull();
  });

  it("returns null for an empty accepts array", () => {
    expect(pickAVMOption([])).toBeNull();
  });

  it("skips non-AVM options and picks the first AVM option", () => {
    expect(pickAVMOption([evmOpt, voiOpt])?.network).toBe("voi-mainnet");
  });

  it("accepts both CAIP-2 and legacy network strings", () => {
    const caip2Opt = { ...BASE_OPT, network: "algorand:mainnet-v1.0" };
    expect(pickAVMOption([caip2Opt])).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTO-13: buildAndSignPayment — new txId+payer proof payload
// ══════════════════════════════════════════════════════════════════════════════

describe("AUTO-13: buildAndSignPayment — txId-based proof payload", () => {
  it("payload.txId equals the value returned by txn.txID()", async () => {
    const { paymentHeader } = await buildAndSignPayment(FAKE_REQ);
    const decoded = JSON.parse(atob(paymentHeader));
    expect(decoded.payload.txId).toBe(MOCK_TX_ID);
  });

  it("payload.payer equals the active account address", async () => {
    const { paymentHeader } = await buildAndSignPayment(FAKE_REQ);
    const decoded = JSON.parse(atob(paymentHeader));
    expect(decoded.payload.payer).toBe(FAKE_ADDR);
  });

  it("payload.transaction is present (rollout compat with pre-production servers)", async () => {
    const { paymentHeader } = await buildAndSignPayment(FAKE_REQ);
    const decoded = JSON.parse(atob(paymentHeader));
    expect(typeof decoded.payload.transaction).toBe("string");
    expect(decoded.payload.transaction.length).toBeGreaterThan(0);
  });

  it("returned txId matches payload.txId", async () => {
    const { txId, paymentHeader } = await buildAndSignPayment(FAKE_REQ);
    const decoded = JSON.parse(atob(paymentHeader));
    expect(txId).toBe(MOCK_TX_ID);
    expect(txId).toBe(decoded.payload.txId);
  });

  it("outer envelope has x402Version=1, correct scheme and network", async () => {
    const { paymentHeader } = await buildAndSignPayment(FAKE_REQ);
    const decoded = JSON.parse(atob(paymentHeader));
    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("algorand-mainnet");
  });

  it("payload.txId is a non-empty string — never sends an empty proof", async () => {
    const { paymentHeader } = await buildAndSignPayment(FAKE_REQ);
    const decoded = JSON.parse(atob(paymentHeader));
    expect(typeof decoded.payload.txId).toBe("string");
    expect(decoded.payload.txId.length).toBeGreaterThan(0);
  });

  it("payload.payer is a non-empty string — proof always includes sender identity", async () => {
    const { paymentHeader } = await buildAndSignPayment(FAKE_REQ);
    const decoded = JSON.parse(atob(paymentHeader));
    expect(typeof decoded.payload.payer).toBe("string");
    expect(decoded.payload.payer.length).toBeGreaterThan(0);
  });

  it("paymentHeader is valid base64 wrapping valid JSON", async () => {
    const { paymentHeader } = await buildAndSignPayment(FAKE_REQ);
    expect(() => JSON.parse(atob(paymentHeader))).not.toThrow();
  });

  it("throws if no active account exists (fail closed)", async () => {
    vi.mocked(walletStore.getMeta).mockResolvedValue(
      makeMeta({ activeAccountId: "nonexistent-id" })
    );
    await expect(buildAndSignPayment(FAKE_REQ)).rejects.toThrow("No active account");
  });
});
