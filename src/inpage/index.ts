/**
 * Inpage script — injected directly into the page's JS context.
 *
 * Provides:
 *   1. window.algorand  — ARC-0027 compliant provider
 *   2. fetch/XHR proxy  — intercepts HTTP 402 responses for x402 payments
 *
 * Communication with content script via window.postMessage
 * (cross-context boundary — cannot use chrome.runtime directly).
 */

import {
  MSG_SOURCE_INPAGE,
  MSG_SOURCE_CONTENT,
  PROVIDER_VERSION,
  PROVIDER_ID,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_SIGNATURE,
} from "../shared/constants";

// ── Correlation IDs ───────────────────────────────────────────────────────────
// Use crypto.randomUUID() — unpredictable, no sequential counter guessing.

function nextId(): string {
  return crypto.randomUUID();
}

// Use page origin as postMessage target to prevent cross-frame eavesdropping.
// Falls back to "*" only for opaque origins (sandboxed iframes).
const _msgTarget = window.location.origin !== "null" ? window.location.origin : "*";

// ── Message bridge ────────────────────────────────────────────────────────────

/** Send a message to the content script and await its response */
function sendToContent<T = unknown>(type: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextId();
    function listener(event: MessageEvent) {
      if (
        event.source !== window ||
        event.data?.source !== MSG_SOURCE_CONTENT ||
        event.data?.id !== id
      ) return;
      window.removeEventListener("message", listener);
      const { ok, data, error } = event.data.payload as { ok: boolean; data: T; error?: string };
      if (ok) resolve(data);
      else reject(new Error(error ?? "Unknown error from content script"));
    }
    window.addEventListener("message", listener);
    window.postMessage({ source: MSG_SOURCE_INPAGE, type, id, payload }, _msgTarget);
  });
}

// ── window.algorand ARC-0027 provider ────────────────────────────────────────

interface EnableResult { accounts: string[]; genesisHash: string; genesisId: string }
interface SignTxnsResult { stxns: (string | null)[] }

// H2: WeakMap to track the native EventListener wrapper registered for each
// (listener, eventName) pair.  Without this, off() tried to remove the original
// `listener` reference which never matches the wrapper closure created in on(),
// so listeners would accumulate forever and could never be detached.
// Outer key = listener fn; inner Map key = event name.
const _listenerWrappers = new WeakMap<
  (...args: unknown[]) => void,
  Map<string, EventListener>
>();

const provider = {
  id: PROVIDER_ID,
  version: PROVIDER_VERSION,
  isAlgoVoi: true,

  async enable(options?: { genesisHash?: string }): Promise<EnableResult> {
    return sendToContent("ARC27_ENABLE", { genesisHash: options?.genesisHash });
  },

  async disable(options?: { genesisHash?: string }): Promise<void> {
    return sendToContent("ARC27_DISCONNECT", { genesisHash: options?.genesisHash });
  },

  async signAndSendTransactions(options: {
    txns: { txn: string; signers?: string[]; authAddr?: string }[];
  }): Promise<{ txnIDs: string[] }> {
    return sendToContent("ARC27_SIGN_AND_SEND", options);
  },

  async signTransactions(
    txns: { txn: string; signers?: string[]; authAddr?: string }[],
    indexesToSign?: number[]
  ): Promise<SignTxnsResult> {
    return sendToContent("ARC27_SIGN_TXNS", { txns, indexesToSign });
  },

  async postTransactions(stxns: string[]): Promise<{ txnIDs: string[] }> {
    return sendToContent("ARC27_POST_TXNS", { stxns });
  },

  async signBytes(data: Uint8Array, signer: string): Promise<{ sig: Uint8Array }> {
    const b64 = btoa(String.fromCharCode(...data));
    const result = await sendToContent<{ sig: string }>("ARC27_SIGN_BYTES", { data: b64, signer });
    return { sig: Uint8Array.from(atob(result.sig), (c) => c.charCodeAt(0)) };
  },

  on(event: string, listener: (...args: unknown[]) => void) {
    // H2: Store the wrapper so off() can look it up and remove the correct function.
    let eventMap = _listenerWrappers.get(listener);
    if (!eventMap) {
      eventMap = new Map<string, EventListener>();
      _listenerWrappers.set(listener, eventMap);
    }
    // Only register once per (listener, event) pair to prevent duplicate wrappers.
    if (!eventMap.has(event)) {
      const wrapper: EventListener = (e: Event) => { listener((e as CustomEvent).detail); };
      eventMap.set(event, wrapper);
      window.addEventListener(`algovou:${event}`, wrapper);
    }
    return this;
  },

  off(event: string, listener: (...args: unknown[]) => void) {
    // H2: Look up the registered wrapper and remove it, not the original listener.
    const eventMap = _listenerWrappers.get(listener);
    if (eventMap) {
      const wrapper = eventMap.get(event);
      if (wrapper) {
        window.removeEventListener(`algovou:${event}`, wrapper);
        eventMap.delete(event);
      }
    }
    return this;
  },

  // ── Sponsored checkout payment ───────────────────────────────────────────────
  /**
   * Build and sign a 0-fee payment transaction for sponsored checkout.
   * The platform backend wraps this in an atomic group with a fee-covering tx.
   * Returns { signedTxB64, senderAddress, chain }.
   */
  async sponsoredSign(params: {
    chain: string;
    receiver: string;
    amount: string;
    assetId: string;
    memo: string;
  }): Promise<{ signedTxB64: string; senderAddress: string; chain: string }> {
    return sendToContent("CHECKOUT_SPONSORED_SIGN", params);
  },

  // ── AP2 (Agent Payments Protocol by Google) ───────────────────────────────
  ap2: Object.freeze({
    /**
     * Request a PaymentMandate for a given CartMandate.
     * Opens the AlgoVoi approval popup; resolves with a signed PaymentMandate
     * once the user approves, or rejects if the user declines.
     */
    requestPayment(cartMandate: unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const requestId = nextId();
        _pendingAp2.set(requestId, { resolve, reject });
        window.postMessage(
          {
            source: MSG_SOURCE_INPAGE,
            type: "AP2_PAYMENT_REQUEST",
            id: requestId,
            payload: { cartMandate, requestId },
          },
          _msgTarget
        );
        // 5-minute timeout matching x402/MPP pattern
        setTimeout(() => {
          if (_pendingAp2.has(requestId)) {
            _pendingAp2.delete(requestId);
            reject(new Error("AP2 payment request timed out"));
          }
        }, 5 * 60 * 1000);
      });
    },

    /**
     * List the IntentMandates stored in this wallet.
     * Requires the page to have been connected via enable() first — prevents
     * wallet fingerprinting by unenabled pages.
     */
    async getIntentMandates(): Promise<unknown[]> {
      // Verify the page is connected before exposing mandate metadata
      const enableResult = await sendToContent<{ accounts: string[] }>("ARC27_ENABLE", {
        genesisID: "",
      }).catch(() => null);
      if (!enableResult?.accounts?.length) {
        throw new Error("ap2.getIntentMandates requires wallet connection via enable() first");
      }
      return sendToContent<unknown[]>("AP2_GET_INTENT_MANDATES", {});
    },
  }),
};

// Inject provider — freeze to prevent dApp tampering
Object.defineProperty(window, "algorand", {
  value: Object.freeze(provider),
  writable: false,
  configurable: false,
});

// Also announce per ARC-0027 discovery
window.dispatchEvent(new CustomEvent("algorand#initialized"));

// ── x402 + MPP fetch interceptor ─────────────────────────────────────────────

const _originalFetch = window.fetch.bind(window);

// Map requestId → { resolve, reject } for pending x402 approvals
const _pendingX402 = new Map<string, { resolve: (header: string) => void; reject: (e: Error) => void }>();
// Map requestId → { resolve, reject } for pending MPP approvals
const _pendingMpp = new Map<string, { resolve: (authHeader: string) => void; reject: (e: Error) => void }>();
// Map requestId → { resolve, reject } for pending AP2 approvals
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _pendingAp2 = new Map<string, { resolve: (mandate: any) => void; reject: (e: Error) => void }>();

// Listen for x402/MPP/AP2 results pushed back from the content script
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.data?.source !== MSG_SOURCE_CONTENT) return;

  if (event.data?.type === "X402_RESULT") {
    const { requestId, approved, paymentHeader, error } = event.data.payload as {
      requestId: string; approved: boolean; paymentHeader?: string; error?: string;
    };
    const pending = _pendingX402.get(requestId);
    if (!pending) return;
    _pendingX402.delete(requestId);
    if (approved && paymentHeader) pending.resolve(paymentHeader);
    else pending.reject(new Error(error ?? "Payment rejected by user"));
  }

  if (event.data?.type === "MPP_RESULT") {
    const { requestId, approved, authorizationHeader, error } = event.data.payload as {
      requestId: string; approved: boolean; authorizationHeader?: string; error?: string;
    };
    const pending = _pendingMpp.get(requestId);
    if (!pending) return;
    _pendingMpp.delete(requestId);
    if (approved && authorizationHeader) pending.resolve(authorizationHeader);
    else pending.reject(new Error(error ?? "MPP payment rejected by user"));
  }

  if (event.data?.type === "AP2_RESULT") {
    const { requestId, approved, paymentMandate, error } = event.data.payload as {
      requestId: string; approved: boolean; paymentMandate?: unknown; error?: string;
    };
    const pending = _pendingAp2.get(requestId);
    if (!pending) return;
    _pendingAp2.delete(requestId);
    if (approved && paymentMandate) pending.resolve(paymentMandate);
    else pending.reject(new Error(error ?? "AP2 payment rejected by user"));
  }
});

window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await _originalFetch(input, init);

  if (response.status !== 402) return response;

  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");

  // ── MPP detection (WWW-Authenticate: Payment) ─────────────────────────────
  // Check for MPP before x402 — the two protocols are disjoint by header name.
  // MPP uses the standard HTTP auth header; x402 uses a custom PAYMENT-REQUIRED header.
  const wwwAuth = response.headers.get("WWW-Authenticate") ?? "";
  if (/Payment\s+/i.test(wwwAuth) && response.headers.get(HEADER_PAYMENT_REQUIRED)) {
    console.warn("[AlgoVoi] Both MPP (WWW-Authenticate) and x402 (PAYMENT-REQUIRED) headers present; using MPP.");
  }
  if (/Payment\s+/i.test(wwwAuth)) {
    let authorizationHeader: string;
    try {
      authorizationHeader = await new Promise<string>((resolve, reject) => {
        const requestId = nextId();
        _pendingMpp.set(requestId, { resolve, reject });
        window.postMessage(
          {
            source: MSG_SOURCE_INPAGE,
            type: "MPP_PAYMENT_NEEDED",
            id: requestId,
            payload: { url, method, rawChallenge: wwwAuth, requestId },
          },
          _msgTarget
        );
        setTimeout(() => {
          if (_pendingMpp.has(requestId)) {
            _pendingMpp.delete(requestId);
            reject(new Error("MPP payment timed out"));
          }
        }, 5 * 60 * 1000);
      });
    } catch (err) {
      console.warn("[AlgoVoi] MPP payment failed:", err);
      return response;
    }

    // Retry with Authorization: Payment <credential>.
    // Strip ALL session/auth headers that must not be forwarded to the payment
    // endpoint. A malicious 402 server could otherwise capture Bearer tokens,
    // API keys, or session cookies from the original request.
    const retryHeaders = new Headers(init?.headers);
    for (const h of ["Cookie", "Authorization", "X-Auth-Token", "X-CSRF-Token", "X-Session-Token", "X-API-Key"]) {
      retryHeaders.delete(h);
    }
    retryHeaders.set("Authorization", authorizationHeader);
    return _originalFetch(input, { ...init, headers: retryHeaders });
  }

  // ── x402 detection (PAYMENT-REQUIRED header) ──────────────────────────────
  // Per the x402 spec (github.com/coinbase/x402), the 402 response carries:
  //   PAYMENT-REQUIRED: <base64(PaymentRequired JSON)>
  // where PaymentRequired = { x402Version, error, accepts: PaymentRequirements[] }
  // Only accept PAYMENT-REQUIRED as an HTTP response header — never from the body.
  // Accepting body-based x402 would let a malicious server craft a JSON body to
  // redirect payment to an arbitrary address without the PAYMENT-REQUIRED header check.
  const rawPaymentRequired = response.headers.get(HEADER_PAYMENT_REQUIRED);

  if (!rawPaymentRequired) return response;

  // Request payment approval from the extension
  let paymentSignature: string;
  try {
    paymentSignature = await new Promise<string>((resolve, reject) => {
      const requestId = nextId();
      _pendingX402.set(requestId, { resolve, reject });
      window.postMessage(
        {
          source: MSG_SOURCE_INPAGE,
          type: "X402_PAYMENT_NEEDED",
          id: requestId,
          payload: { url, method, rawPaymentRequired, requestId },
        },
        _msgTarget
      );
      // Timeout after 5 minutes (user may take time to approve)
      setTimeout(() => {
        if (_pendingX402.has(requestId)) {
          _pendingX402.delete(requestId);
          reject(new Error("x402 payment timed out"));
        }
      }, 5 * 60 * 1000);
    });
  } catch (err) {
    console.warn("[AlgoVoi] x402 payment failed:", err);
    return response; // Return the original 402 response to the caller
  }

  // Retry the original request with PAYMENT-SIGNATURE header.
  // Strip ALL session/auth headers that must not be auto-forwarded to a payment
  // endpoint. A malicious 402 server could otherwise harvest Bearer tokens,
  // API keys, or session cookies from the original request.
  const retryHeaders = new Headers(init?.headers);
  for (const h of ["Cookie", "Authorization", "X-Auth-Token", "X-CSRF-Token", "X-Session-Token", "X-API-Key"]) {
    retryHeaders.delete(h);
  }
  // Echo the exact PAYMENT-REQUIRED value from the original 402 response so the
  // server can correlate this retry with the payment challenge it issued.
  // rawPaymentRequired is derived from response.headers (network-provided, not
  // page-controlled) and was validated by the background before approval.
  retryHeaders.set(HEADER_PAYMENT_REQUIRED, rawPaymentRequired);
  retryHeaders.set(HEADER_PAYMENT_SIGNATURE, paymentSignature);
  return _originalFetch(input, { ...init, headers: retryHeaders });
};

// XHR interception is deferred to Phase 2; the fetch wrapper above covers all
// modern use cases.  Legacy XMLHttpRequest calls will not be intercepted.
