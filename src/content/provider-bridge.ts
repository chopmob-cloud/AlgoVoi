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
    if (msg.type === "CHAIN_CHANGED" || msg.type === "ACCOUNT_CHANGED") {
      window.dispatchEvent(
        new CustomEvent(`algovou:${msg.type.toLowerCase().replace("_", "")}`, {
          detail: msg,
        })
      );
    }
  });
}

async function routeToBackground(msg: InpageMessage): Promise<unknown> {
  const origin = window.location.origin;

  switch (msg.type) {
    case "ARC27_ENABLE": {
      // Explicitly destructure — do NOT spread payload which could override `origin`
      const { genesisHash, accounts } = (msg.payload ?? {}) as {
        genesisHash?: string;
        accounts?: string[];
      };
      return sendToBg({ type: "ARC27_ENABLE", origin, genesisHash, accounts });
    }

    case "ARC27_DISCONNECT":
      return sendToBg({ type: "ARC27_DISCONNECT", origin });

    case "ARC27_SIGN_TXNS": {
      const { txns, indexesToSign } = msg.payload as { txns: { txn: string }[]; indexesToSign?: number[] };
      return sendToBg({
        type: "ARC27_SIGN_TXNS",
        origin,
        txns: txns.map((t) => t.txn),
        indexesToSign,
      });
    }

    case "ARC27_SIGN_BYTES": {
      const { data, signer } = msg.payload as { data: string; signer: string };
      return sendToBg({ type: "ARC27_SIGN_BYTES", origin, data, signer });
    }

    case "ARC27_POST_TXNS": {
      // TODO: submit raw signed txns via algod
      throw new Error("postTransactions not yet implemented");
    }

    case "ARC27_SIGN_AND_SEND": {
      const result = await sendToBg<{ stxns: (string | null)[] }>({
        type: "ARC27_SIGN_TXNS",
        origin,
        txns: (msg.payload as { txns: { txn: string }[] }).txns.map((t) => t.txn),
      });
      // TODO: submit and return txnIDs
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
      if (response.ok) resolve(response.data);
      else reject(new Error(response.error ?? "Background error"));
    });
  });
}
