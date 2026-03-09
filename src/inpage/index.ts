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
};

// Inject provider — freeze to prevent dApp tampering
Object.defineProperty(window, "algorand", {
  value: Object.freeze(provider),
  writable: false,
  configurable: false,
});

// Also announce per ARC-0027 discovery
window.dispatchEvent(new CustomEvent("algorand#initialized"));

// ── x402 fetch interceptor ────────────────────────────────────────────────────

const _originalFetch = window.fetch.bind(window);

// Map requestId → { resolve, reject } for pending x402 approvals
const _pendingX402 = new Map<string, { resolve: (header: string) => void; reject: (e: Error) => void }>();

// Listen for x402 results pushed back from the content script
window.addEventListener("message", (event: MessageEvent) => {
  if (
    event.source !== window ||
    event.data?.source !== MSG_SOURCE_CONTENT ||
    event.data?.type !== "X402_RESULT"
  ) return;
  const { requestId, approved, paymentHeader, error } = event.data.payload as {
    requestId: string;
    approved: boolean;
    paymentHeader?: string;
    error?: string;
  };
  const pending = _pendingX402.get(requestId);
  if (!pending) return;
  _pendingX402.delete(requestId);
  if (approved && paymentHeader) {
    pending.resolve(paymentHeader);
  } else {
    pending.reject(new Error(error ?? "Payment rejected by user"));
  }
});

window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await _originalFetch(input, init);

  if (response.status !== 402) return response;

  // Per the x402 spec (github.com/coinbase/x402), the 402 response carries:
  //   PAYMENT-REQUIRED: <base64(PaymentRequired JSON)>
  // where PaymentRequired = { x402Version, error, accepts: PaymentRequirements[] }
  const paymentHeader =
    response.headers.get(HEADER_PAYMENT_REQUIRED) ??
    // Fallback: some early / non-spec implementations put it in the body
    // We'll attempt body parse in the background; pass null here to trigger it.
    (response.headers.get("content-type")?.includes("application/json") ? "__body__" : null);

  if (!paymentHeader) return response;

  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");

  // If the header signals the body contains the PaymentRequired JSON, read it.
  let rawPaymentRequired = paymentHeader;
  if (paymentHeader === "__body__") {
    try {
      // Clone before consuming — the original response body is already consumed
      const bodyText = await response.clone().text();
      // Encode the body JSON as base64 so the background can parse it uniformly
      rawPaymentRequired = btoa(bodyText);
    } catch {
      return response;
    }
  }

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
  // M3: Drop Cookie (session credentials must never be auto-forwarded) but
  // preserve Authorization — bearer tokens are legitimately needed for auth'd endpoints.
  const retryHeaders = new Headers(init?.headers);
  retryHeaders.delete("Cookie");
  if (retryHeaders.has("Authorization")) {
    // Authorization header is forwarded to the retry; dApp developers should verify
    // this endpoint is the intended recipient before enabling x402 payments.
    console.warn("[AlgoVoi] x402 retry: Authorization header forwarded — verify endpoint.");
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
