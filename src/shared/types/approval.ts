/**
 * Unified approval-request types.
 *
 * Covers three privileged operations that require explicit user confirmation
 * before the extension performs any irreversible action:
 *
 *   sign_txns      — ARC-0027: dApp calls window.algorand.signTransactions()
 *   sign_bytes     — ARC-0027: dApp calls window.algorand.signBytes()
 *   envoi_payment  — enVoi name resolution triggers an x402 VOI payment
 *
 * All three flows share:
 *   - A single in-memory queue in approval-handler.ts
 *   - The same popup entry point (src/approval/index.html)
 *   - The same TTL (APPROVAL_TTL_MS)
 *   - One-shot semantics: a request is consumed exactly once
 */

// ── Request kinds ─────────────────────────────────────────────────────────────

export type ApprovalKind = "sign_txns" | "sign_bytes" | "envoi_payment";

/** Auto-reject TTL — 5 minutes */
export const APPROVAL_TTL_MS = 5 * 60 * 1_000;

// ── Per-kind shapes ───────────────────────────────────────────────────────────

/**
 * Decoded summary of one unsigned transaction, computed in the background
 * (which has algosdk) so the approval popup can display plain-language details
 * without needing to bundle a second transaction decoder.
 */
export interface TxnSummary {
  /** AVM transaction type string: "pay", "axfer", "appl", "keyreg", etc. */
  type: string;
  /** Full sender address */
  sender: string;
  /** Full receiver address (pay / axfer) */
  receiver?: string;
  /** Human-readable amount string, e.g. "1.500000 ALGO" */
  amount?: string;
  /** ASA ID for axfer transactions (0 = native coin) */
  assetId?: number;
  /** True when this index is NOT in indexesToSign (displayed greyed out) */
  skipped?: boolean;

  // ── Dangerous-field flags (shown as warnings in the approval popup) ─────────

  /** rekeyTo address — permanently transfers signing authority to another key */
  rekeyTo?: string;
  /** closeRemainderTo — sends ALL remaining ALGO balance to this address */
  closeRemainderTo?: string;
  /** assetCloseTo — sends ALL remaining ASA balance to this address */
  assetCloseTo?: string;
  /**
   * Actual transaction fee in µALGO/µVOI. Always present when the transaction
   * was decoded. The UI flags it as HIGH when > 10 000 µ (10× the 1 000 µ minimum).
   */
  feeMicroalgos?: number;
  /** decoded note field (UTF-8 text or hex preview for binary data) */
  note?: string;
  /** onCompletion label for appl transactions: NoOp / OptIn / CloseOut / ClearState / UpdateApp / DeleteApp */
  applType?: string;
  /**
   * Short validity window flag. True when lastValid - firstValid < 10 rounds
   * (~40 seconds on Algorand). Phishing indicator — pressures user to approve
   * before they can read the details.
   */
  shortValidityWindow?: boolean;
  /**
   * For axfer (asset transfer) clawback transactions: the address being clawed
   * back from. Non-empty means the transaction forcibly moves ASA units OUT of
   * another account — one of the most dangerous AVM operations.
   */
  clawbackFrom?: string;
  /**
   * True when the transaction carries a non-zero lease field.
   * A lease prevents any other transaction from the same sender with the same
   * lease from being accepted until this one expires — can be used to lock out
   * an account from sending replacements.
   */
  hasLease?: boolean;
  /**
   * For afrz (asset freeze) transactions: the address whose holding is being
   * frozen or unfrozen, and the direction.
   */
  freezeTarget?: string;
  freezing?: boolean; // true = freeze, false = unfreeze
  /**
   * For keyreg transactions: true when the transaction registers (enables)
   * participation keys; false when it takes the account offline.
   * Undefined for all other transaction types.
   */
  keyregOnline?: boolean;
  /** true when the transaction could not be decoded — approval popup shows explicit blind-sign gate */
  blind?: boolean;
}

/**
 * Queued when a connected dApp calls window.algorand.signTransactions().
 *
 * `txnSummaries` is decoded by the background before queuing, so the popup
 * can display readable details without bundling algosdk itself.
 */
export interface PendingSignTxnsApproval {
  kind: "sign_txns";
  id: string;
  /** Chrome-provided requesting origin (from sender.url — unforgeable) */
  origin: string;
  /** Chrome tab ID the request originated from */
  tabId: number;
  /** Base64-encoded unsigned transaction msgpack bytes, one per element */
  txns: string[];
  /** Subset of indices the dApp wants signed; undefined means sign all */
  indexesToSign?: number[];
  /** Pre-decoded summaries for popup display */
  txnSummaries: TxnSummary[];
  timestamp: number;
}

/**
 * Queued when a connected dApp calls window.algorand.signBytes().
 *
 * The MX prefix (ARC-1) is applied in the background AFTER approval —
 * never before — to prevent the prefix appearing in the displayed data.
 */
export interface PendingSignBytesApproval {
  kind: "sign_bytes";
  id: string;
  /** Chrome-provided requesting origin */
  origin: string;
  tabId: number;
  /** Base64-encoded raw bytes (before the MX prefix is applied) */
  data: string;
  /** The address the dApp wants to sign with (validated against active account) */
  signer: string;
  timestamp: number;
}

/**
 * Queued when enVoi name resolution triggers an x402 payment to the UluMCP
 * server. Always on the Voi chain (enVoi is Voi-only).
 *
 * The payment details come from the MCP 402 response and are validated
 * (isValidAddress, positive amount, spending-cap check) before queuing.
 */
export interface PendingEnvoiApproval {
  kind: "envoi_payment";
  id: string;
  /** The full .voi name being resolved, e.g. "shelly.voi" */
  name: string;
  /** Recipient address from the MCP 402 response */
  payTo: string;
  /** Amount in microVOI — stored as string to avoid BigInt serialisation issues */
  amount: string;
  /** Always "voi"; present for type-safety and UI display */
  chain: "voi";
  timestamp: number;
}

/** Discriminated union of all approval request types */
export type PendingApproval =
  | PendingSignTxnsApproval
  | PendingSignBytesApproval
  | PendingEnvoiApproval;
