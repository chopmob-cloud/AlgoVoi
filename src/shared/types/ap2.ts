/**
 * AP2 — Agent Payments Protocol (Google)
 * https://github.com/google-agentic-commerce/AP2
 *
 * AlgoVoi acts as a credentials provider (wallet):
 *   - Stores IntentMandates (user spending authorizations)
 *   - Signs PaymentMandates using the user's ed25519 key
 *   - Exposes window.algorand.ap2 for AI agents running in the page
 *
 * AP2 does NOT submit an AVM transaction — it only signs a credential.
 * The merchant/agent handles payment settlement separately.
 */

// ── IntentMandate ─────────────────────────────────────────────────────────────

/**
 * User's purchase intent — authorizes an AI agent to purchase under conditions.
 * Stored in chrome.storage.local (not in the encrypted vault — not secret).
 */
export interface IntentMandate {
  id: string;
  natural_language_description: string;
  user_cart_confirmation_required: boolean;
  /** ISO amount string e.g. "10.00" */
  max_amount?: string;
  /** ISO 4217 e.g. "USD" */
  currency?: string;
  merchant_restrictions?: string[];
  /** ISO 8601 */
  intent_expiry?: string;
  created_at: number;
  network: "algorand" | "voi";
  address: string; // signer address
}

// ── CartMandate ───────────────────────────────────────────────────────────────

export interface CartMandateContents {
  transaction_id: string;
  items: { label: string; amount: { currency: string; value: string } }[];
  total: { currency: string; value: string };
  merchant_id?: string;
  /** ISO 8601, typically 5–15 min */
  expiry?: string;
}

/**
 * Merchant-signed JWT guaranteeing cart contents + W3C PaymentRequest object.
 */
export interface CartMandate {
  contents: CartMandateContents;
  /** JWT signed by merchant */
  merchant_authorization: string;
}

// ── PaymentMandate ────────────────────────────────────────────────────────────

export interface PaymentMandateContents {
  payment_id: string;
  /** SHA-256 of CartMandate JSON */
  cart_mandate_hash: string;
  intent_mandate_id: string;
  amount: { currency: string; value: string };
  network: "algorand" | "voi";
  address: string;
  timestamp: number;
}

/**
 * Payment credential binding user to cart + payment.
 *
 * user_authorization format:
 *   base64url(JSON.stringify(contents)) + "." + base64url(ed25519_signature_bytes)
 *
 * The ed25519 signature is produced by algosdk.signBytes over JSON.stringify(contents).
 */
export interface PaymentMandate {
  contents: PaymentMandateContents;
  user_authorization: string;
}

// ── Pending approval shape ────────────────────────────────────────────────────

/**
 * Queued when a page calls window.algorand.ap2.requestPayment().
 * The background validates the CartMandate before queuing.
 */
export interface PendingAp2Approval {
  kind: "ap2_payment";
  id: string;
  /** Chrome tab ID the request originated from (for AP2_RESULT routing) */
  tabId: number;
  url: string;
  /** The full CartMandate, retained so buildPaymentMandate can hash it correctly */
  cartMandate: CartMandate;
  merchant_id?: string;
  transaction_id: string;
  items: CartMandateContents["items"];
  total: CartMandateContents["total"];
  intent_mandate_id?: string;
  /** inpage-generated requestId used to route AP2_RESULT back to the pending Promise */
  inpageRequestId?: string;
  network: "algorand" | "voi";
  address: string;
  expiry?: string;
  timestamp: number;
  /** True when the active account is WalletConnect — AP2 ed25519 signing is unsupported */
  isWalletConnect?: boolean;
}
