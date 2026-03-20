/**
 * Unified approval-request queue.
 *
 * Manages in-memory pending requests for ARC-0027 signing (sign_txns,
 * sign_bytes) and enVoi paid name resolution (envoi_payment).
 *
 * Each request is:
 *   - One-shot      : consumed exactly once (approve OR reject — not both)
 *   - Origin-bound  : carries the Chrome-provided sender origin
 *   - Short-lived   : auto-rejected after APPROVAL_TTL_MS (5 minutes)
 *
 * Lifecycle:
 *   1. Caller builds a PendingApproval and calls requestApproval(approval).
 *   2. requestApproval() stores it, arms a TTL timer, opens the popup, and
 *      returns a Promise<boolean> that will settle when the user responds.
 *   3. The popup fetches the request via getPendingApproval(id).
 *   4. User clicks Approve → popup sends APPROVAL_APPROVE  → resolveApproval(id).
 *      User clicks Reject  → popup sends APPROVAL_REJECT   → rejectApproval(id).
 *   5. The Promise settles; all associated state is cleaned up atomically.
 *
 * Fail-closed invariants:
 *   - Unknown requestId          → resolveApproval/rejectApproval are no-ops (safe)
 *   - Popup closed without action → TTL fires → rejectApproval() auto-fires
 *   - Popup open failure          → openApprovalPopup catch → rejectApproval()
 *   - Duplicate requestId         → immediate rejection (randomId() prevents this)
 *   - Service-worker restart      → in-memory state lost → caller receives error
 *                                   (dApp must re-initiate — safe failure mode)
 */

import { randomId } from "@shared/utils/crypto";
import { APPROVAL_TTL_MS } from "@shared/types/approval";
import { APPROVAL_POPUP_WIDTH, APPROVAL_POPUP_HEIGHT } from "@shared/constants";
import type { PendingApproval, ApprovalKind } from "@shared/types/approval";

// ── In-memory state ───────────────────────────────────────────────────────────
// All three maps are keyed by requestId.  They are always mutated together
// (insert in requestApproval; delete in clearPendingApproval + _resolvers).

const _pending   = new Map<string, PendingApproval>();
const _timers    = new Map<string, ReturnType<typeof setTimeout>>();
const _resolvers = new Map<string, {
  resolve: (approved: boolean) => void;
  reject:  (reason: Error)    => void;
}>();
/** Stores the Chrome window ID for each open approval popup, keyed by requestId. */
const _windowIds = new Map<string, number>();

// ── Public read accessor ──────────────────────────────────────────────────────

/**
 * Return the pending approval for `id`, or null if it has already settled
 * or was never created.  Safe to call with any string.
 */
export function getPendingApproval(id: string): PendingApproval | null {
  return _pending.get(id) ?? null;
}

// ── Internal cleanup ──────────────────────────────────────────────────────────

/**
 * Remove the pending request and disarm its TTL timer.
 * Does NOT touch _resolvers (they are removed by resolveApproval/rejectApproval).
 * Idempotent — safe to call with unknown IDs.
 */
export function clearPendingApproval(id: string): void {
  _pending.delete(id);
  _windowIds.delete(id);
  const t = _timers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    _timers.delete(id);
  }
}

// ── Settlement helpers (called by message-handler) ────────────────────────────

/**
 * Resolve: the user clicked Approve.
 * Atomically clears all stored state and resolves the pending Promise.
 */
export function resolveApproval(id: string): void {
  const resolver = _resolvers.get(id);
  _resolvers.delete(id);
  clearPendingApproval(id);
  resolver?.resolve(true);
}

/**
 * Reject: the user clicked Reject, the TTL expired, or an error occurred.
 * Atomically clears all stored state and rejects the pending Promise.
 */
export function rejectApproval(id: string, reason: string): void {
  const resolver = _resolvers.get(id);
  _resolvers.delete(id);
  clearPendingApproval(id);
  resolver?.reject(new Error(reason));
}

/**
 * Count how many pending approvals share the given origin.
 * Only sign_txns and sign_bytes approvals carry an `origin` field;
 * envoi_payment entries are excluded via the "origin" in approval guard.
 */
export function countPendingByOrigin(origin: string): number {
  let count = 0;
  for (const approval of _pending.values()) {
    if ("origin" in approval && approval.origin === origin) count++;
  }
  return count;
}

/**
 * Return and consume the Chrome window ID for an approval popup.
 * Call this before closing/clearing the request so you have the ID.
 */
export function getApprovalWindowId(id: string): number | undefined {
  const windowId = _windowIds.get(id);
  _windowIds.delete(id);
  return windowId;
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Queue an approval request, open the approval popup, and return a Promise
 * that resolves (true) when the user approves, or rejects with a descriptive
 * Error when the user rejects, the TTL fires, or the popup cannot open.
 *
 * The caller MUST await this promise before performing any privileged action
 * (signing a transaction, signing bytes, making a payment, etc.).
 * This await IS the security gate.
 *
 * @param approval  A fully constructed PendingApproval with a unique ID.
 * @returns         Promise<boolean> — resolves true on approval.
 * @throws          Duplicate-ID error immediately (synchronously) if id is
 *                  already pending.  All other failures are async rejections.
 */
export function requestApproval(approval: PendingApproval): Promise<boolean> {
  const { id } = approval;

  // Duplicate guard: randomId() uses crypto.randomUUID() so collisions are
  // astronomically unlikely, but we fail-safe here rather than silently overwrite.
  if (_pending.has(id)) {
    return Promise.reject(new Error(`Duplicate approval request ID: ${id}`));
  }

  _pending.set(id, approval);

  // Arm TTL — auto-reject so a closed popup never leaves a dangling promise.
  const timer = setTimeout(() => {
    rejectApproval(id, "Approval request timed out. Please try again.");
  }, APPROVAL_TTL_MS);
  _timers.set(id, timer);

  // Create the Promise before opening the popup so the resolver is registered
  // even if openApprovalPopup resolves synchronously in tests.
  const promise = new Promise<boolean>((resolve, reject) => {
    _resolvers.set(id, { resolve, reject });
  });

  // Open the popup asynchronously — failure auto-rejects the caller's promise.
  openApprovalPopup(id, approval.kind).catch((err: Error) => {
    rejectApproval(id, `Could not open approval popup: ${err.message}`);
  });

  return promise;
}

// Re-export randomId so callers can build approvals without a separate import.
export { randomId };

// ── Internal ──────────────────────────────────────────────────────────────────

async function openApprovalPopup(id: string, kind: ApprovalKind): Promise<void> {
  // Validate kind against known values before injecting into URL — prevents
  // any future code path from accidentally constructing a URL with user-controlled kind.
  const VALID_KINDS: readonly string[] = ["sign_txns", "sign_bytes", "envoi_payment", "mpp_charge", "ap2_payment"];
  if (!VALID_KINDS.includes(kind)) throw new Error(`Unknown approval kind: ${kind}`);
  const popupUrl = new URL(chrome.runtime.getURL("src/approval/index.html"));
  popupUrl.searchParams.set("requestId", id);
  popupUrl.searchParams.set("kind", kind);
  const url = popupUrl.toString();
  const win = await chrome.windows.create({
    url,
    type: "popup",
    width: APPROVAL_POPUP_WIDTH,
    height: APPROVAL_POPUP_HEIGHT,
    focused: true,
  });
  if (win.id !== undefined) _windowIds.set(id, win.id);
}
