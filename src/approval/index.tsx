import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../popup/index.css";
import { formatAmount } from "@shared/utils/format";
import { CHAINS } from "@shared/constants";
import { signTransactionWithWC } from "@shared/utils/wc-sign";
import type { PendingX402Request } from "@shared/types/x402";
import type { ChainId } from "@shared/types/chain";

// ── URL-safe base64 polyfill ──────────────────────────────────────────────────
// The WalletConnect SDK calls globalThis.atob() internally (in @walletconnect/
// encoding) when decoding relay messages. Some wallets (e.g. Pera) use URL-safe
// base64 encoding (- and _ instead of + and /), which native atob() rejects with
// "The string to be decoded is not correctly encoded." Patching globalThis.atob
// here normalises any URL-safe or unpadded input before forwarding to the native
// implementation — covers WC SDK internals as well as any remaining raw atob()
// calls in our own code.
/* eslint-disable @typescript-eslint/no-explicit-any */
(function patchAtob() {
  const _native = (globalThis as any).atob.bind(globalThis);
  (globalThis as any).atob = function atob(input: string): string {
    // Guard: non-string (null/undefined/number) — coerce so replace() doesn't throw
    const s = String(input == null ? "" : input);
    // Normalise: URL-safe chars → standard, strip whitespace (PEM newlines),
    // strip any existing = padding before recalculating — prevents double-padding
    // when base64ToBytes has already added = and then calls atob() through us.
    const stripped = s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/\s/g, "")
      .replace(/=+$/, "");
    const padded = stripped + "=".repeat((4 - (stripped.length % 4)) % 4);
    return _native(padded);
  };
  console.log("[AlgoVoi] atob polyfill installed");
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

function sendBg<T = unknown>(msg: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: { ok: boolean; data: T; error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res.ok) resolve(res.data);
      else reject(new Error(res.error ?? "Error"));
    });
  });
}

function resolveChain(network: string): ChainId | null {
  if (network === "algorand-mainnet") return "algorand";
  if (network === "voi-mainnet") return "voi";
  return null;
}

// WC sign state returned from X402_APPROVE when active account is WalletConnect
interface WCSignParams {
  unsignedTxnB64: string;
  chain: ChainId;
  sessionTopic: string;
  signerAddress: string;
}

function ApprovalPage() {
  const [request, setRequest] = useState<PendingX402Request | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [wcWaiting, setWcWaiting] = useState(false);
  const [error, setError] = useState("");

  const requestId = new URLSearchParams(window.location.search).get("requestId") ?? "";

  useEffect(() => {
    if (!requestId) {
      setError("Missing requestId");
      setLoading(false);
      return;
    }
    sendBg<{ request: PendingX402Request | null }>({ type: "X402_GET_PENDING", requestId })
      .then(({ request: req }) => {
        if (!req) setError("Payment request not found or expired");
        else setRequest(req);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [requestId]);

  async function handleWcSign(wcData: WCSignParams) {
    setWcWaiting(true);
    setError("");
    try {
      // Opens a signing request in Defly/Pera — user approves on their phone.
      // signTransactionWithWC returns raw bytes (handles URL-safe b64 + nested arrays).
      const signedBytes = await signTransactionWithWC(
        wcData.sessionTopic,
        wcData.chain,
        wcData.unsignedTxnB64,
        wcData.signerAddress
      );
      // Re-encode as standard base64 before sending over chrome.runtime.sendMessage
      const signedTxnB64 = btoa(String.fromCharCode(...signedBytes));
      // Hand the signed bytes back to the background to wrap + submit
      await sendBg({ type: "X402_WC_SIGNED", requestId, signedTxnB64 });
      window.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet rejected the payment");
      setWcWaiting(false);
    }
  }

  async function approve() {
    setSubmitting(true);
    setError("");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await sendBg<any>({ type: "X402_APPROVE", requestId });

      if (result.needsWcSign) {
        // WalletConnect account — pass signing to the popup's WC client
        setSubmitting(false);
        const wcData: WCSignParams = {
          unsignedTxnB64: result.unsignedTxnB64,
          chain: result.chain,
          sessionTopic: result.sessionTopic,
          signerAddress: result.signerAddress,
        };
        await handleWcSign(wcData);
      } else {
        // Vault account — background already signed + submitted
        window.close();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
      setSubmitting(false);
    }
  }

  async function reject() {
    await sendBg({ type: "X402_REJECT", requestId }).catch(() => {});
    window.close();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="w-6 h-6 border-2 border-algo border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error && !request) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4 p-6">
        <p className="text-red-400 text-sm text-center">{error}</p>
        <button className="btn-secondary" onClick={() => window.close()}>
          Close
        </button>
      </div>
    );
  }

  const pr = request!.paymentRequirements;
  const chain = resolveChain(pr.network);
  const chainCfg = chain ? CHAINS[chain] : null;
  const isNative = pr.asset === "0" || !pr.asset;
  const assetLabel = isNative
    ? chainCfg?.ticker ?? pr.network
    : `ASA ${pr.asset}`;
  const decimals = chainCfg?.decimals ?? 6;
  const displayAmount = formatAmount(BigInt(pr.maxAmountRequired), decimals);

  return (
    <div className="flex flex-col min-h-screen p-5 gap-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-algo rounded-lg flex items-center justify-center text-black font-bold text-sm">
          AV
        </div>
        <div>
          <h1 className="text-base font-bold leading-none">Payment Request</h1>
          <p className="text-xs text-gray-400 mt-0.5">x402 — AlgoVoi</p>
        </div>
      </div>

      {/* Origin */}
      <div className="card">
        <p className="text-xs text-gray-400 mb-1">Requesting site</p>
        <p className="text-sm font-medium truncate">{request!.url}</p>
      </div>

      {/* Payment details */}
      <div className="card flex flex-col gap-3">
        <p className="text-xs text-gray-400 uppercase tracking-wider">Payment Details</p>

        <div className="flex justify-between items-start">
          <span className="text-sm text-gray-400">Amount</span>
          <div className="text-right">
            <span className="text-xl font-bold text-white">{displayAmount}</span>
            <span className="text-sm text-gray-400 ml-1.5">{assetLabel}</span>
          </div>
        </div>

        <div className="flex justify-between">
          <span className="text-sm text-gray-400">Network</span>
          <span className={`text-sm font-medium ${chain === "algorand" ? "text-algo" : "text-voi"}`}>
            {chainCfg?.name ?? pr.network}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-sm text-gray-400">Pay to</span>
          <span className="text-xs font-mono text-gray-300 break-all leading-relaxed">
            {pr.payTo}
          </span>
        </div>

        {pr.description && (
          <div className="border-t border-surface-3 pt-2">
            <p className="text-xs text-gray-400 mb-1">Description</p>
            <p className="text-sm text-gray-300">{pr.description}</p>
          </div>
        )}
      </div>

      {/* ASA opt-in warning */}
      {!isNative && (
        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-3">
          <p className="text-xs text-yellow-400">
            ⚠ This payment uses ASA #{pr.asset}. Ensure your account is opted in to this asset.
          </p>
        </div>
      )}

      {/* WalletConnect waiting state */}
      {wcWaiting && (
        <div className="bg-surface-2 border border-white/10 rounded-xl p-4 flex flex-col items-center gap-3">
          <div className="w-6 h-6 border-2 border-algo border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-gray-300 text-center">
            Open your wallet app and approve the payment
          </p>
          <p className="text-xs text-gray-500 text-center">
            Waiting for signature from your connected wallet…
          </p>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Actions — hidden while waiting for WC approval */}
      {!wcWaiting && (
        <div className="flex gap-3 mt-auto">
          <button
            className="btn-secondary flex-1"
            onClick={reject}
            disabled={submitting}
          >
            Reject
          </button>
          <button
            className="btn-primary flex-1"
            onClick={approve}
            disabled={submitting}
          >
            {submitting ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                Sending…
              </span>
            ) : (
              `Pay ${displayAmount} ${assetLabel}`
            )}
          </button>
        </div>
      )}

      {/* WC waiting — only show Reject to allow cancellation */}
      {wcWaiting && (
        <div className="mt-auto">
          <button
            className="btn-secondary w-full"
            onClick={reject}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApprovalPage />
  </StrictMode>
);
