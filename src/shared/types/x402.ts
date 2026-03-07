/**
 * x402 HTTP Payment Protocol types for AVM (Algorand/Voi) chains.
 * Based on the x402 spec: https://x402.org / github.com/coinbase/x402
 *
 * Header protocol (v1):
 *   402 response  → PAYMENT-REQUIRED: <base64(PaymentRequired JSON)>
 *   Client retry  → PAYMENT-SIGNATURE: <base64(X402PaymentPayload JSON)>
 *   200 response  → PAYMENT-RESPONSE: <base64(SettlementResponse JSON)>
 */

export type X402Scheme = "exact";

/** Per-option inside the `accepts` array of a PaymentRequired response */
export interface PaymentRequirements {
  scheme: X402Scheme;
  /**
   * Network identifier. Coinbase uses CAIP-2 (e.g. "eip155:8453").
   * GoPlausible AVM extension uses "algorand-mainnet" | "voi-mainnet".
   */
  network: string;
  /** Maximum payment amount in atomic units (string to avoid precision loss) */
  maxAmountRequired: string;
  /** The protected resource URL */
  resource: string;
  /** Human-readable description shown to user in approval dialog */
  description: string;
  mimeType: string;
  /** Recipient address (AVM: base32 address; EVM: 0x address) */
  payTo: string;
  maxTimeoutSeconds: number;
  /**
   * Asset identifier.
   * AVM: ASA ID as string, or "0" for native coin (ALGO/VOI).
   * EVM: token contract address (0x...).
   */
  asset: string;
  outputSchema?: unknown;
  extra?: Record<string, unknown>;
}

/**
 * The body of an HTTP 402 response.
 * Sent in the `PAYMENT-REQUIRED` response header as base64(JSON).
 */
export interface PaymentRequired {
  x402Version: 1;
  /** Human-readable explanation of why payment is required */
  error: string;
  /** Ordered list of accepted payment options (client picks one) */
  accepts: PaymentRequirements[];
}

/**
 * AVM-specific payment payload (analogous to EVM's EIP-3009 authorization).
 * The signed AVM transaction group encodes the payment atomically.
 */
export interface AVMPaymentPayloadInner {
  /** Base64-encoded signed transaction bytes (algosdk msgpack) */
  transaction: string;
  /** Optional nonce/context echoed from the server's PaymentRequirements */
  context?: string;
}

/**
 * Full x402 payment payload sent in the `PAYMENT-SIGNATURE` header.
 * Header value = base64(JSON.stringify(X402PaymentPayload))
 */
export interface X402PaymentPayload {
  x402Version: 1;
  scheme: X402Scheme;
  network: string;
  payload: AVMPaymentPayloadInner;
}

/** A pending x402 payment request queued in the background worker */
export interface PendingX402Request {
  id: string; // uuid
  tabId: number;
  url: string;
  method: string;
  /** Original request headers (serialisable subset) */
  headers: Record<string, string>;
  /** Original request body if applicable */
  body?: string;
  /** The chosen PaymentRequirements option from the accepts[] array */
  paymentRequirements: PaymentRequirements;
  /** All options from the server (for display / fallback) */
  allRequirements: PaymentRequirements[];
  timestamp: number;
}

/** Result of a completed payment signing */
export interface X402PaymentResult {
  requestId: string;
  approved: boolean;
  /** base64(X402PaymentPayload) — goes in PAYMENT-SIGNATURE header */
  paymentHeader?: string;
  error?: string;
}

/** Settlement response returned by the facilitator POST /settle */
export interface SettlementResponse {
  success: boolean;
  transaction: string; // tx hash / tx ID
  network: string;
  payer: string;
  errorReason?: string;
}

/** Payment history entry stored per-session */
export interface PaymentRecord {
  id: string;
  url: string;
  amount: string;
  asset: string;
  network: string;
  payTo: string;
  txId: string;
  timestamp: number;
}
