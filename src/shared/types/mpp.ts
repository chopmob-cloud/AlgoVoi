/**
 * MPP (Machine Payments Protocol) wire types.
 *
 * Spec: https://mpp.dev / https://paymentauth.org
 * IETF draft: draft-ryan-httpauth-payment
 *
 * Wire protocol:
 *   402 response:  WWW-Authenticate: Payment id="...", realm="...", method="avm",
 *                    intent="charge", request="<base64url-json>", [description="..."]
 *   Client retry:  Authorization: Payment <base64url-json({ challenge, source, payload })>
 *   200 response:  Payment-Receipt: <base64url-json>
 *
 * AlgoVoi implements the custom "avm" payment method, which uses an
 * Algorand or Voi on-chain transaction as the payment proof.
 */

// ── Challenge (from WWW-Authenticate header) ──────────────────────────────────

/** Parsed parameters from `WWW-Authenticate: Payment ...` */
export interface MppChallenge {
  /** Unique challenge ID (HMAC-bound to all other params) */
  id: string;
  /** Protection space identifier, typically the server hostname */
  realm: string;
  /** Payment method name, lowercase ASCII. AlgoVoi handles "avm". */
  method: string;
  /** Payment pattern. AlgoVoi handles "charge". */
  intent: string;
  /** base64url-encoded (no padding) JSON — method-specific payment parameters */
  request: string;
  /** RFC 3339 expiry timestamp (optional) */
  expires?: string;
  /** Content digest per RFC 9530 for body binding (optional) */
  digest?: string;
  /** Human-readable description of what is being paid for (optional) */
  description?: string;
  /** Server-defined correlation data, base64url-encoded (optional) */
  opaque?: string;
}

// ── AVM method — request / payload ───────────────────────────────────────────

/**
 * Decoded `request` field for method="avm", intent="charge".
 * Passed as base64url(JSON) in the WWW-Authenticate challenge.
 */
export interface MppAvmRequest {
  /** Amount in microunits as an integer string (e.g. "1000000" = 1 ALGO) */
  amount: string;
  /**
   * Currency identifier:
   *   "ALGO"        — native Algorand coin
   *   "VOI"         — native Voi coin
   *   "<numeric>"   — ASA ID (e.g. "31566704" for USDC on Algorand)
   */
  currency: string;
  /** Algorand-format recipient address (58-char base32) */
  recipient: string;
  /** Chain identifier: "algorand" | "voi" */
  network: string;
  /** Decimal places for display (default 6) */
  decimals?: number;
  /** Human-readable description (may duplicate challenge.description) */
  description?: string;
}

/** Credential payload for method="avm" */
export interface MppAvmPayload {
  /** On-chain transaction ID (the payment proof) */
  txId: string;
  /** Standard base64-encoded signed transaction msgpack bytes */
  transaction: string;
}

// ── Credential (Authorization header body) ────────────────────────────────────

/**
 * The JSON object base64url-encoded in the Authorization: Payment header.
 *
 * Authorization: Payment <base64url(MppCredential)>
 */
export interface MppCredential {
  /** Echo of the original challenge parameters */
  challenge: MppChallenge;
  /**
   * Payer identifier as a DID.
   * AlgoVoi uses: "did:pkh:avm:<network>:<address>"
   */
  source?: string;
  /** Method-specific payment proof */
  payload: MppAvmPayload;
}

// ── Pending request (queued for approval) ────────────────────────────────────

/** A pending MPP payment request waiting for user approval */
export interface PendingMppRequest {
  /** Internal unique ID (background-generated) */
  id: string;
  tabId: number;
  /** URL of the resource that returned 402 */
  url: string;
  /** HTTP method of the original request */
  method: string;
  /** Parsed MPP challenge from WWW-Authenticate header */
  challenge: MppChallenge;
  /** Decoded AVM payment parameters */
  avmRequest: MppAvmRequest;
  timestamp: number;
  /** Chrome-verified origin of the requesting tab */
  tabOrigin?: string;
  /** requestId from the inpage script (used to route MPP_RESULT back) */
  inpageRequestId?: string;
  /** Raw WWW-Authenticate header value for reference */
  rawChallenge: string;
  /** accountId of the active account at request creation time — asserted on approval */
  accountId?: string;
}
