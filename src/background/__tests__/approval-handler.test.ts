/**
 * Unit tests for src/background/approval-handler.ts
 *
 * Environment: "node" (vitest.config.ts). Chrome extension APIs are stubbed
 * per-test via vi.stubGlobal. Each test gets a fresh crypto.randomUUID() so
 * the module-level Maps never receive colliding keys.
 *
 * Fail-closed invariants verified:
 *  ✓ Unknown IDs are safe no-ops (resolve/reject/clear never throw)
 *  ✓ Duplicate ID guard rejects immediately (synchronously returns rejected promise)
 *  ✓ TTL auto-rejects after APPROVAL_TTL_MS (fake timers)
 *  ✓ TTL does NOT fire before APPROVAL_TTL_MS
 *  ✓ Popup open failure auto-rejects with descriptive message
 *  ✓ resolveApproval settles the promise with `true` and cleans up all state
 *  ✓ rejectApproval settles the promise with a thrown Error and cleans up state
 *  ✓ clearPendingApproval removes the pending entry and disarms the timer
 *  ✓ getPendingApproval returns null after settlement
 *  ✓ All three approval kinds (sign_txns, sign_bytes, envoi_payment) are handled
 *  ✓ Popup URL contains requestId and kind query params
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getPendingApproval,
  clearPendingApproval,
  resolveApproval,
  rejectApproval,
  requestApproval,
} from "../approval-handler";
import { APPROVAL_TTL_MS } from "@shared/types/approval";
import type {
  PendingEnvoiApproval,
  PendingSignBytesApproval,
  PendingSignTxnsApproval,
} from "@shared/types/approval";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Not a real Algorand address, but approval-handler does not validate it.
const FAKE_ADDRESS = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function makeEnvoi(id: string): PendingEnvoiApproval {
  return {
    kind: "envoi_payment",
    id,
    name: "test.voi",
    payTo: FAKE_ADDRESS,
    amount: "1000000",
    chain: "voi",
    timestamp: Date.now(),
  };
}

function makeSignBytes(id: string): PendingSignBytesApproval {
  return {
    kind: "sign_bytes",
    id,
    origin: "https://example.com",
    tabId: 1,
    data: btoa("hello world"),
    signer: FAKE_ADDRESS,
    timestamp: Date.now(),
  };
}

function makeSignTxns(id: string): PendingSignTxnsApproval {
  return {
    kind: "sign_txns",
    id,
    origin: "https://example.com",
    tabId: 1,
    txns: [btoa("faketxnbytes")],
    txnSummaries: [
      { type: "pay", sender: FAKE_ADDRESS, receiver: FAKE_ADDRESS, amount: "1.000000 ALGO" },
    ],
    timestamp: Date.now(),
  };
}

/** Stub chrome APIs; returns the `windows.create` mock for inspection. */
function stubChrome(
  windowsCreate: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ id: 42 })
): ReturnType<typeof vi.fn> {
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (p: string) => `chrome-extension://testextid/${p}`,
    },
    windows: {
      create: windowsCreate,
    },
  });
  return windowsCreate;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("approval-handler", () => {
  let id: string;

  beforeEach(() => {
    // Fresh unique ID for every test — prevents cross-test map key collisions.
    id = crypto.randomUUID();
    vi.useRealTimers();
    stubChrome();
  });

  afterEach(() => {
    // Disarm any live timer so it cannot fire into subsequent tests.
    // Uses clearPendingApproval (not rejectApproval) to avoid triggering
    // an unhandled-rejection warning on a dangling promise.
    clearPendingApproval(id);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ── getPendingApproval ──────────────────────────────────────────────────────

  describe("getPendingApproval", () => {
    it("returns null for an unknown ID", () => {
      expect(getPendingApproval("no-such-id")).toBeNull();
    });

    it("returns the stored approval immediately after requestApproval", async () => {
      const approval = makeEnvoi(id);
      const p = requestApproval(approval);
      expect(getPendingApproval(id)).toEqual(approval);
      // Settle to avoid dangling promise.
      rejectApproval(id, "cleanup");
      await p.catch(() => {});
    });

    it("returns null after resolveApproval", async () => {
      const p = requestApproval(makeEnvoi(id));
      resolveApproval(id);
      await p;
      expect(getPendingApproval(id)).toBeNull();
    });

    it("returns null after rejectApproval", async () => {
      const p = requestApproval(makeEnvoi(id));
      rejectApproval(id, "done");
      await p.catch(() => {});
      expect(getPendingApproval(id)).toBeNull();
    });
  });

  // ── resolveApproval ────────────────────────────────────────────────────────

  describe("resolveApproval", () => {
    it("settles the promise with true", async () => {
      const p = requestApproval(makeEnvoi(id));
      resolveApproval(id);
      await expect(p).resolves.toBe(true);
    });

    it("cleans up pending map and timer atomically", async () => {
      const p = requestApproval(makeEnvoi(id));
      resolveApproval(id);
      await p;
      expect(getPendingApproval(id)).toBeNull();
      // Double-resolve should be a no-op (resolver already removed).
      expect(() => resolveApproval(id)).not.toThrow();
    });

    it("is a no-op for an unknown ID — does not throw", () => {
      expect(() => resolveApproval("no-such-id")).not.toThrow();
    });
  });

  // ── rejectApproval ─────────────────────────────────────────────────────────

  describe("rejectApproval", () => {
    it("rejects the promise with the provided reason", async () => {
      const p = requestApproval(makeEnvoi(id));
      rejectApproval(id, "User rejected");
      await expect(p).rejects.toThrow("User rejected");
    });

    it("cleans up pending map and timer atomically", async () => {
      const p = requestApproval(makeEnvoi(id));
      rejectApproval(id, "done");
      await p.catch(() => {});
      expect(getPendingApproval(id)).toBeNull();
      // Double-reject should be a no-op.
      expect(() => rejectApproval(id, "again")).not.toThrow();
    });

    it("is a no-op for an unknown ID — does not throw", () => {
      expect(() => rejectApproval("no-such-id", "whatever")).not.toThrow();
    });
  });

  // ── clearPendingApproval ───────────────────────────────────────────────────

  describe("clearPendingApproval", () => {
    it("removes the approval from the pending map", async () => {
      const p = requestApproval(makeEnvoi(id));
      clearPendingApproval(id);
      expect(getPendingApproval(id)).toBeNull();
      // Resolver is still registered; settle it to avoid dangling promise.
      rejectApproval(id, "cleanup");
      await p.catch(() => {});
    });

    it("is a no-op for an unknown ID — does not throw", () => {
      expect(() => clearPendingApproval("no-such-id")).not.toThrow();
    });

    it("is idempotent — calling twice does not throw", async () => {
      const p = requestApproval(makeEnvoi(id));
      clearPendingApproval(id);
      expect(() => clearPendingApproval(id)).not.toThrow();
      rejectApproval(id, "cleanup");
      await p.catch(() => {});
    });
  });

  // ── TTL auto-reject ────────────────────────────────────────────────────────

  describe("TTL auto-reject", () => {
    it("auto-rejects the promise after APPROVAL_TTL_MS elapses", async () => {
      vi.useFakeTimers();
      const p = requestApproval(makeEnvoi(id));

      vi.advanceTimersByTime(APPROVAL_TTL_MS + 1);

      await expect(p).rejects.toThrow("timed out");
      expect(getPendingApproval(id)).toBeNull();
    });

    it("does NOT auto-reject before APPROVAL_TTL_MS elapses", async () => {
      vi.useFakeTimers();
      const p = requestApproval(makeEnvoi(id));

      vi.advanceTimersByTime(APPROVAL_TTL_MS - 1);

      // Pending entry must still be present.
      expect(getPendingApproval(id)).not.toBeNull();

      // Settle so no dangling promise survives the test.
      rejectApproval(id, "cleanup");
      await p.catch(() => {});
    });
  });

  // ── Duplicate ID guard ─────────────────────────────────────────────────────

  describe("duplicate ID guard", () => {
    it("rejects immediately when the same ID is queued twice", async () => {
      const p1 = requestApproval(makeEnvoi(id));
      const p2 = requestApproval({ ...makeEnvoi(id) }); // same id

      await expect(p2).rejects.toThrow(`Duplicate approval request ID: ${id}`);

      // Clean up the first request.
      rejectApproval(id, "cleanup");
      await p1.catch(() => {});
    });
  });

  // ── Popup open failure ─────────────────────────────────────────────────────

  describe("popup open failure", () => {
    it("auto-rejects the promise when chrome.windows.create rejects", async () => {
      // Re-stub with a failing windows.create.
      vi.unstubAllGlobals();
      stubChrome(vi.fn().mockRejectedValue(new Error("Extension context invalidated")));

      const p = requestApproval(makeEnvoi(id));

      await expect(p).rejects.toThrow(
        "Could not open approval popup: Extension context invalidated"
      );
      expect(getPendingApproval(id)).toBeNull();
    });
  });

  // ── Popup URL shape ────────────────────────────────────────────────────────

  describe("popup URL", () => {
    it("passes requestId and kind as URL query params to chrome.windows.create", async () => {
      vi.unstubAllGlobals();
      const createMock = vi.fn().mockResolvedValue({ id: 99 });
      stubChrome(createMock);

      const p = requestApproval(makeEnvoi(id));

      // Wait one macrotask tick so the async openApprovalPopup can run.
      await new Promise((r) => setTimeout(r, 0));

      expect(createMock).toHaveBeenCalledOnce();
      const { url, type } = createMock.mock.calls[0][0] as { url: string; type: string };
      expect(type).toBe("popup");
      expect(url).toContain(`requestId=${encodeURIComponent(id)}`);
      expect(url).toContain("kind=envoi_payment");
      expect(url).toContain("src/approval/index.html");

      rejectApproval(id, "cleanup");
      await p.catch(() => {});
    });
  });

  // ── All three approval kinds ───────────────────────────────────────────────

  describe("all three approval kinds", () => {
    it("sign_txns — resolves true on approval", async () => {
      const p = requestApproval(makeSignTxns(id));
      resolveApproval(id);
      await expect(p).resolves.toBe(true);
    });

    it("sign_bytes — resolves true on approval", async () => {
      const p = requestApproval(makeSignBytes(id));
      resolveApproval(id);
      await expect(p).resolves.toBe(true);
    });

    it("envoi_payment — resolves true on approval", async () => {
      const p = requestApproval(makeEnvoi(id));
      resolveApproval(id);
      await expect(p).resolves.toBe(true);
    });

    it("sign_txns — rejects on rejection", async () => {
      const p = requestApproval(makeSignTxns(id));
      rejectApproval(id, "Denied");
      await expect(p).rejects.toThrow("Denied");
    });

    it("sign_bytes — rejects on rejection", async () => {
      const p = requestApproval(makeSignBytes(id));
      rejectApproval(id, "Denied");
      await expect(p).rejects.toThrow("Denied");
    });

    it("envoi_payment — rejects on rejection", async () => {
      const p = requestApproval(makeEnvoi(id));
      rejectApproval(id, "Denied");
      await expect(p).rejects.toThrow("Denied");
    });
  });
});
