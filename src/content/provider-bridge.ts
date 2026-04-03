/**
 * Provider bridge — relays messages between the inpage script and the
 * background service worker.
 *
 * inpage  →  window.postMessage(source: "algovou-inpage")
 *         →  content script (this file) listens
 *         →  chrome.runtime.sendMessage → background
 *         →  sendResponse → content script
 *         →  window.postMessage(source: "algovou-content") → inpage
 */

import { MSG_SOURCE_INPAGE, MSG_SOURCE_CONTENT } from "@shared/constants";
import type { InpageMessage } from "@shared/types/messages";

export function setupProviderBridge(): void {
  // Use page origin as postMessage target so other frames can't eavesdrop.
  // Falls back to "*" only for opaque origins (e.g. sandboxed iframes).
  const msgTarget = window.location.origin !== "null" ? window.location.origin : "*";

  window.addEventListener("message", async (event: MessageEvent) => {
    if (event.source !== window) return;
    const msg = event.data as Partial<InpageMessage>;
    if (msg?.source !== MSG_SOURCE_INPAGE || !msg.type || !msg.id) return;

    try {
      const result = await routeToBackground(msg as InpageMessage);
      window.postMessage(
        {
          source: MSG_SOURCE_CONTENT,
          type: msg.type,
          id: msg.id,
          payload: { ok: true, data: result },
        },
        msgTarget
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      window.postMessage(
        {
          source: MSG_SOURCE_CONTENT,
          type: msg.type,
          id: msg.id,
          payload: { ok: false, error },
        },
        msgTarget
      );
    }
  });

  // Listen for notifications pushed from the background (e.g. chain change)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "X402_RESULT") {
      // Relay x402 result back to the inpage script
      window.postMessage(
        {
          source: MSG_SOURCE_CONTENT,
          type: "X402_RESULT",
          id: msg.requestId,
          payload: {
            requestId: msg.requestId,
            approved: msg.approved,
            paymentHeader: msg.paymentHeader,
            error: msg.error,
          },
        },
        msgTarget
      );
    }
    if (msg.type === "MPP_RESULT") {
      // Relay MPP result back to the inpage script
      window.postMessage(
        {
          source: MSG_SOURCE_CONTENT,
          type: "MPP_RESULT",
          id: msg.requestId,
          payload: {
            requestId: msg.requestId,
            approved: msg.approved,
            authorizationHeader: msg.authorizationHeader,
            error: msg.error,
          },
        },
        msgTarget
      );
    }
    if (msg.type === "AP2_RESULT") {
      // Relay AP2 result back to the inpage script
      window.postMessage(
        {
          source: MSG_SOURCE_CONTENT,
          type: "AP2_RESULT",
          id: msg.requestId,
          payload: {
            requestId: msg.requestId,
            approved: msg.approved,
            paymentMandate: msg.paymentMandate,
            error: msg.error,
          },
        },
        msgTarget
      );
    }
    if (msg.type === "CHAIN_CHANGED" || msg.type === "ACCOUNT_CHANGED") {
      // L1: Use an explicit map rather than string manipulation.
      // `.replace("_", "")` only removes the FIRST underscore, producing
      // "chainchanged"/"accountchanged" — neither matches what dApps expect.
      // ARC-0027 event names: chainChanged, accountsChanged.
      const ARC27_EVENT: Record<string, string> = {
        CHAIN_CHANGED: "chainChanged",
        ACCOUNT_CHANGED: "accountsChanged",
      };
      const eventName = ARC27_EVENT[msg.type];
      window.dispatchEvent(
        new CustomEvent(`algovou:${eventName}`, {
          detail: msg,
        })
      );
    }
  });
}

async function routeToBackground(msg: InpageMessage): Promise<unknown> {
  const origin = window.location.origin;

  // Anti-phishing: detect homograph/IDN domains that use Unicode chars to
  // mimic legitimate sites (e.g., Cyrillic 'а' in аlgorand.com).
  // Warning is included in the message to the background so the approval
  // popup can display it.
  let homographWarning: string | undefined;
  try {
    const hostname = new URL(origin).hostname;
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7F]/.test(hostname)) {
      const punycode = new URL(`https://${hostname}`).hostname;
      homographWarning =
        `This site uses non-standard characters in its domain (${punycode}). ` +
        `It may be impersonating a legitimate site.`;
    }
  } catch { /* invalid origin — caught by HTTPS guard below */ }

  // L1: Defence-in-depth HTTPS guard. The manifest content_scripts already
  // restricts injection to https://* so this path is ordinarily unreachable,
  // but an explicit check ensures no signing request ever originates from an
  // insecure or opaque origin even if the manifest is misconfigured in future.
  // The http://localhost carve-out is intentional for developer testing only —
  // localhost has no real-world attack surface and is not reachable externally.
  if (!origin.startsWith("https://") && origin !== "http://localhost") {
    throw new Error("AlgoVoi provider is not available on insecure origins.");
  }

  switch (msg.type) {
    case "ARC27_ENABLE": {
      // Explicitly destructure — do NOT spread payload which could override `origin`
      const { genesisHash, accounts } = (msg.payload ?? {}) as {
        genesisHash?: string;
        accounts?: string[];
      };
      return sendToBg({ type: "ARC27_ENABLE", origin, genesisHash, accounts, homographWarning });
    }

    case "ARC27_DISCONNECT":
      return sendToBg({ type: "ARC27_DISCONNECT", origin });

    case "ARC27_SIGN_TXNS": {
      const { txns, indexesToSign } = (msg.payload ?? {}) as {
        txns?: unknown;
        indexesToSign?: number[];
      };
      // M2: Validate txns is an array before mapping.
      if (!Array.isArray(txns)) throw new Error("ARC27_SIGN_TXNS: txns must be an array");
      // Validate indexesToSign: must be an array of non-negative integers within bounds.
      if (indexesToSign !== undefined) {
        if (
          !Array.isArray(indexesToSign) ||
          indexesToSign.some(
            (i) => !Number.isInteger(i) || i < 0 || i >= (txns as unknown[]).length
          )
        ) {
          throw new Error("ARC27_SIGN_TXNS: indexesToSign must be non-negative integers within txns bounds");
        }
      }
      return sendToBg({
        type: "ARC27_SIGN_TXNS",
        origin,
        txns: (txns as { txn: string }[]).map((t) => t.txn),
        indexesToSign,
      });
    }

    case "ARC27_SIGN_BYTES": {
      const { data, signer } = msg.payload as { data: string; signer: string };
      return sendToBg({ type: "ARC27_SIGN_BYTES", origin, data, signer });
    }

    case "ARC27_POST_TXNS":
      // Phase 2: direct algod submission via postTransactions is not yet implemented.
      throw new Error("postTransactions not yet implemented");

    case "ARC27_SIGN_AND_SEND": {
      // Phase 2: signing works but algod submission is deferred; txnIDs is empty.
      const payload = msg.payload as { txns?: unknown };
      if (!Array.isArray(payload?.txns)) throw new Error("txns must be an array");
      const result = await sendToBg<{ stxns: (string | null)[] }>({
        type: "ARC27_SIGN_TXNS",
        origin,
        txns: (payload.txns as { txn: string }[]).map((t) => t.txn),
      });
      return { stxns: result.stxns, txnIDs: [] };
    }

    case "X402_PAYMENT_NEEDED": {
      // rawPaymentRequired = base64(PAYMENT-REQUIRED header value) per x402 spec
      const { url, method, rawPaymentRequired, requestId } = msg.payload as {
        url: string; method: string; rawPaymentRequired: string; requestId: string;
      };
      // Forward to background; paymentRequirements field carries the raw base64 value
      return sendToBg({
        type: "X402_PAYMENT_NEEDED",
        url,
        method,
        paymentRequirements: rawPaymentRequired,
        requestId,
        tabId: -1, // background will use sender.tab.id
      });
    }

    case "MPP_PAYMENT_NEEDED": {
      // rawChallenge = raw value of WWW-Authenticate: Payment header
      const { url, method, rawChallenge, requestId } = msg.payload as {
        url: string; method: string; rawChallenge: string; requestId: string;
      };
      return sendToBg({
        type: "MPP_PAYMENT_NEEDED",
        url,
        method,
        rawChallenge,
        requestId,
        tabId: -1, // background will use sender.tab.id
      });
    }

    case "AP2_PAYMENT_REQUEST": {
      // cartMandate = CartMandate object from the page
      const { cartMandate, requestId } = msg.payload as {
        cartMandate: unknown; requestId: string;
      };
      const ap2Url = window.location.href;
      return sendToBg({
        type: "AP2_PAYMENT_REQUEST",
        cartMandate,
        requestId,
        url: ap2Url,
        tabId: -1, // background will use sender.tab.id
      });
    }

    case "AP2_GET_INTENT_MANDATES": {
      return sendToBg({ type: "AP2_LIST_INTENT_MANDATES" });
    }

    case "CHECKOUT_SPONSORED_SIGN": {
      const { chain, receiver, amount, assetId, memo } = msg.payload as {
        chain: string; receiver: string; amount: string; assetId: string; memo: string;
      };
      return sendToBg({ type: "CHECKOUT_SPONSORED_SIGN", chain, receiver, amount, assetId, memo });
    }

    default:
      throw new Error(`Unhandled inpage message type: ${msg.type}`);
  }
}

function sendToBg<T = unknown>(message: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: { ok: boolean; data: T; error?: string }) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response) { reject(new Error("No response from background")); return; }
      if (response.ok) resolve(response.data);
      else reject(new Error(response.error ?? "Background error"));
    });
  });
}
