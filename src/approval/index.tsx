import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../popup/index.css";
import { formatAmount } from "@shared/utils/format";
import { CHAINS } from "@shared/constants";
import { signTransactionWithWC } from "@shared/utils/wc-sign";
import type { PendingX402Request } from "@shared/types/x402";
import type { PendingApproval, PendingSignTxnsApproval, PendingSignBytesApproval, PendingEnvoiApproval, TxnSummary } from "@shared/types/approval";
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
    const s = String(input == null ? "" : input);
    const stripped = s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/\s/g, "")
      .replace(/=+$/, "");
    const padded = stripped + "=".repeat((4 - (stripped.length % 4)) % 4);
    return _native(padded);
  };
})();
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Shared helpers ────────────────────────────────────────────────────────────

function sendBg<T = unknown>(msg: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: { ok: boolean; data: T; error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res.ok) resolve(res.data);
      else reject(new Error(res.error ?? "Error"));
    });
  });
}

function resolveChainFromNetwork(network: string): ChainId | null {
  if (network === "algorand-mainnet" || network === "algorand:mainnet-v1.0") return "algorand";
  if (network === "voi-mainnet"      || network === "voi:voimain-v1.0")      return "voi";
  return null;
}

// ── URL params ────────────────────────────────────────────────────────────────

const _params    = new URLSearchParams(window.location.search);
const REQUEST_ID = _params.get("requestId") ?? "";
const KIND       = _params.get("kind") ?? "";       // "sign_txns" | "sign_bytes" | "envoi_payment" | ""

// ── Root component ────────────────────────────────────────────────────────────

function ApprovalPage() {
  if (!REQUEST_ID) {
    return <ErrorScreen message="Missing requestId parameter" />;
  }
  // Route by kind — empty kind = legacy x402 flow
  if (KIND === "sign_txns")     return <SignTxnsPage    requestId={REQUEST_ID} />;
  if (KIND === "sign_bytes")    return <SignBytesPage   requestId={REQUEST_ID} />;
  if (KIND === "envoi_payment") return <EnvoiPage       requestId={REQUEST_ID} />;
  return                               <X402Page        requestId={REQUEST_ID} />;
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function Spinner({ size = 6 }: { size?: number }) {
  return (
    <div
      className={`w-${size} h-${size} border-2 border-algo border-t-transparent rounded-full animate-spin`}
    />
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-screen gap-4 p-6">
      <p className="text-red-400 text-sm text-center">{message}</p>
      <button className="btn-secondary" onClick={() => window.close()}>Close</button>
    </div>
  );
}

function OriginBadge({ origin }: { origin: string }) {
  return (
    <div className="card">
      <p className="text-xs text-gray-400 mb-1">Requesting site</p>
      <p className="text-sm font-medium truncate">{origin}</p>
    </div>
  );
}

function ApproveRejectBar({
  approveLabel,
  rejectLabel = "Reject",
  onApprove,
  onReject,
  approving,
  disabled,
}: {
  approveLabel: string;
  rejectLabel?: string;
  onApprove: () => void;
  onReject: () => void;
  approving: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-3 mt-auto">
      <button className="btn-secondary flex-1" onClick={onReject} disabled={approving || disabled}>
        {rejectLabel}
      </button>
      <button
        className="btn-primary flex-1"
        onClick={onApprove}
        disabled={approving || disabled}
      >
        {approving ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
            Working…
          </span>
        ) : approveLabel}
      </button>
    </div>
  );
}

// ── Sign Transactions page ────────────────────────────────────────────────────

function TxnRow({ summary, index }: { summary: TxnSummary; index: number }) {
  if (summary.skipped) {
    return (
      <div className="flex justify-between items-center opacity-40 text-xs py-1.5 border-b border-surface-3 last:border-0">
        <span className="font-mono text-gray-500">Txn {index + 1}</span>
        <span className="text-gray-500 italic">not signing (delegated slot)</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 py-1.5 border-b border-surface-3 last:border-0">
      <div className="flex justify-between items-center">
        <span className="text-xs font-mono text-gray-400">Txn {index + 1}</span>
        <span className="text-xs font-semibold uppercase tracking-wider text-algo">
          {summary.type}
        </span>
      </div>
      {summary.sender && (
        <p className="text-[10px] font-mono text-gray-500 truncate">
          From: {summary.sender}
        </p>
      )}
      {summary.receiver && (
        <p className="text-[10px] font-mono text-gray-500 truncate">
          To: {summary.receiver}
        </p>
      )}
      {summary.amount && (
        <p className="text-xs font-semibold text-white">{summary.amount}</p>
      )}
    </div>
  );
}

function SignTxnsPage({ requestId }: { requestId: string }) {
  const [approval, setApproval] = useState<PendingSignTxnsApproval | null>(null);
  const [loading,   setLoading]  = useState(true);
  const [approving, setApproving] = useState(false);
  const [error,     setError]    = useState("");

  useEffect(() => {
    sendBg<{ approval: PendingApproval | null }>({ type: "APPROVAL_GET_PENDING", requestId })
      .then(({ approval: a }) => {
        if (!a || a.kind !== "sign_txns") {
          setError("Signing request not found or already settled");
        } else {
          setApproval(a as PendingSignTxnsApproval);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [requestId]);

  async function approve() {
    setApproving(true);
    setError("");
    try {
      await sendBg({ type: "APPROVAL_APPROVE", requestId });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed");
      setApproving(false);
    }
  }

  async function reject() {
    await sendBg({ type: "APPROVAL_REJECT", requestId }).catch(() => {});
    window.close();
  }

  if (loading) return <div className="flex items-center justify-center h-screen"><Spinner /></div>;
  if (!approval) return <ErrorScreen message={error || "Request not found"} />;

  const toSign = approval.txns.length - (approval.indexesToSign
    ? approval.txns.length - approval.indexesToSign.length
    : 0);

  return (
    <div className="flex flex-col min-h-screen p-5 gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-yellow-500 rounded-lg flex items-center justify-center text-black font-bold text-sm">✎</div>
        <div>
          <h1 className="text-base font-bold leading-none">Sign Transactions</h1>
          <p className="text-xs text-gray-400 mt-0.5">ARC-0027 — AlgoVoi</p>
        </div>
      </div>

      <OriginBadge origin={approval.origin} />

      <div className="card flex flex-col gap-1">
        <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">
          Transactions ({toSign} to sign, {approval.txns.length} total)
        </p>
        {approval.txnSummaries.map((s, i) => (
          <TxnRow key={i} summary={s} index={i} />
        ))}
      </div>

      <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-3">
        <p className="text-xs text-yellow-300">
          ⚠ These transactions will be signed with your wallet key and sent to the requesting site.
          Only approve if you trust <strong>{approval.origin}</strong>.
        </p>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <ApproveRejectBar
        approveLabel={`Sign ${toSign} transaction${toSign !== 1 ? "s" : ""}`}
        onApprove={approve}
        onReject={reject}
        approving={approving}
      />
    </div>
  );
}

// ── Sign Bytes page ───────────────────────────────────────────────────────────

function SignBytesPage({ requestId }: { requestId: string }) {
  const [approval, setApproval] = useState<PendingSignBytesApproval | null>(null);
  const [loading,   setLoading]  = useState(true);
  const [approving, setApproving] = useState(false);
  const [error,     setError]    = useState("");

  useEffect(() => {
    sendBg<{ approval: PendingApproval | null }>({ type: "APPROVAL_GET_PENDING", requestId })
      .then(({ approval: a }) => {
        if (!a || a.kind !== "sign_bytes") {
          setError("Signing request not found or already settled");
        } else {
          setApproval(a as PendingSignBytesApproval);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [requestId]);

  async function approve() {
    setApproving(true);
    setError("");
    try {
      await sendBg({ type: "APPROVAL_APPROVE", requestId });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed");
      setApproving(false);
    }
  }

  async function reject() {
    await sendBg({ type: "APPROVAL_REJECT", requestId }).catch(() => {});
    window.close();
  }

  // Decode base64 → first 64 bytes → hex for display
  function previewHex(b64: string): string {
    try {
      const bin = atob(b64);
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      const preview = bytes.slice(0, 64);
      return Array.from(preview).map((b) => b.toString(16).padStart(2, "0")).join(" ")
        + (bytes.length > 64 ? " …" : "");
    } catch {
      return "(could not decode)";
    }
  }

  if (loading) return <div className="flex items-center justify-center h-screen"><Spinner /></div>;
  if (!approval) return <ErrorScreen message={error || "Request not found"} />;

  return (
    <div className="flex flex-col min-h-screen p-5 gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-purple-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">✎</div>
        <div>
          <h1 className="text-base font-bold leading-none">Sign Data</h1>
          <p className="text-xs text-gray-400 mt-0.5">ARC-0027 · signBytes — AlgoVoi</p>
        </div>
      </div>

      <OriginBadge origin={approval.origin} />

      <div className="card flex flex-col gap-2">
        <p className="text-xs text-gray-400 uppercase tracking-wider">Data to sign (hex preview)</p>
        <p className="text-[10px] font-mono text-gray-300 break-all leading-relaxed bg-surface-2 rounded-lg p-2">
          {previewHex(approval.data)}
        </p>
        <div className="flex justify-between text-xs text-gray-500">
          <span>Signer</span>
          <span className="font-mono truncate max-w-[200px]">{approval.signer}</span>
        </div>
      </div>

      <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
        <p className="text-xs text-red-300">
          ⚠ Signing data proves your wallet identity to the requesting site.
          This signature cannot be used as a transaction, but it may be used
          to authenticate you or authorise off-chain operations.
          Only approve from sites you <strong>fully trust</strong>.
        </p>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <ApproveRejectBar
        approveLabel="Sign data"
        onApprove={approve}
        onReject={reject}
        approving={approving}
      />
    </div>
  );
}

// ── enVoi payment page ────────────────────────────────────────────────────────

function EnvoiPage({ requestId }: { requestId: string }) {
  const [approval, setApproval] = useState<PendingEnvoiApproval | null>(null);
  const [loading,   setLoading]  = useState(true);
  const [approving, setApproving] = useState(false);
  const [error,     setError]    = useState("");

  useEffect(() => {
    sendBg<{ approval: PendingApproval | null }>({ type: "APPROVAL_GET_PENDING", requestId })
      .then(({ approval: a }) => {
        if (!a || a.kind !== "envoi_payment") {
          setError("Payment request not found or already settled");
        } else {
          setApproval(a as PendingEnvoiApproval);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [requestId]);

  async function approve() {
    setApproving(true);
    setError("");
    try {
      await sendBg({ type: "APPROVAL_APPROVE", requestId });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed");
      setApproving(false);
    }
  }

  async function reject() {
    await sendBg({ type: "APPROVAL_REJECT", requestId }).catch(() => {});
    window.close();
  }

  if (loading) return <div className="flex items-center justify-center h-screen"><Spinner /></div>;
  if (!approval) return <ErrorScreen message={error || "Request not found"} />;

  const chainCfg = CHAINS["voi"];
  // L7: Defensive wrap — mcp-client validates the amount before opening this
  // popup, but guard here too so a future code path can't crash the page.
  const displayAmount = formatAmount(
    /^\d+$/.test(String(approval.amount)) ? BigInt(approval.amount) : 0n,
    chainCfg.decimals
  );

  return (
    <div className="flex flex-col min-h-screen p-5 gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-voi/80 rounded-lg flex items-center justify-center text-white font-bold text-sm">⬡</div>
        <div>
          <h1 className="text-base font-bold leading-none">Name Resolution Payment</h1>
          <p className="text-xs text-gray-400 mt-0.5">enVoi via UluMCP — AlgoVoi</p>
        </div>
      </div>

      <div className="card">
        <p className="text-xs text-gray-400 mb-1">Resolving name</p>
        <p className="text-base font-semibold text-voi">{approval.name}</p>
      </div>

      <div className="card flex flex-col gap-3">
        <p className="text-xs text-gray-400 uppercase tracking-wider">Payment Details</p>
        <div className="flex justify-between items-start">
          <span className="text-sm text-gray-400">Amount</span>
          <div className="text-right">
            <span className="text-xl font-bold text-white">{displayAmount}</span>
            <span className="text-sm text-gray-400 ml-1.5">{chainCfg.ticker}</span>
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-gray-400">Network</span>
          <span className="text-sm font-medium text-voi">{chainCfg.name}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-gray-400">Pay to (UluMCP server)</span>
          <span className="text-xs font-mono text-gray-300 break-all leading-relaxed">
            {approval.payTo}
          </span>
        </div>
      </div>

      <div className="bg-surface-2 border border-white/10 rounded-xl p-3">
        <p className="text-xs text-gray-400">
          This fee is charged by the enVoi name service to resolve{" "}
          <strong className="text-white">{approval.name}</strong> to a Voi address.
        </p>
      </div>

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <ApproveRejectBar
        approveLabel={`Pay ${displayAmount} ${chainCfg.ticker}`}
        rejectLabel="Cancel"
        onApprove={approve}
        onReject={reject}
        approving={approving}
      />
    </div>
  );
}

// ── x402 page (existing flow, preserved exactly) ─────────────────────────────

interface WCSignParams {
  unsignedTxnB64: string;
  chain: ChainId;
  sessionTopic: string;
  signerAddress: string;
}

function X402Page({ requestId }: { requestId: string }) {
  const [request,   setRequest]   = useState<PendingX402Request | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [wcWaiting, setWcWaiting] = useState(false);
  const [error,     setError]     = useState("");

  useEffect(() => {
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
      const signedBytes = await signTransactionWithWC(
        wcData.sessionTopic,
        wcData.chain,
        wcData.unsignedTxnB64,
        wcData.signerAddress
      );
      const signedTxnB64 = btoa(String.fromCharCode(...signedBytes));
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
        setSubmitting(false);
        await handleWcSign({
          unsignedTxnB64: result.unsignedTxnB64,
          chain: result.chain,
          sessionTopic: result.sessionTopic,
          signerAddress: result.signerAddress,
        });
      } else {
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
    return <div className="flex items-center justify-center h-screen"><Spinner /></div>;
  }
  if (error && !request) return <ErrorScreen message={error} />;

  const pr        = request!.paymentRequirements;
  const chain     = resolveChainFromNetwork(pr.network);
  const chainCfg  = chain ? CHAINS[chain] : null;
  const isNative  = pr.asset === "0" || !pr.asset;
  const assetLabel = isNative ? chainCfg?.ticker ?? pr.network : `ASA ${pr.asset}`;
  const decimals  = chainCfg?.decimals ?? 6;
  const displayAmount = formatAmount(BigInt(pr.maxAmountRequired), decimals);

  return (
    <div className="flex flex-col min-h-screen p-5 gap-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-algo rounded-lg flex items-center justify-center text-black font-bold text-sm">AV</div>
        <div>
          <h1 className="text-base font-bold leading-none">Payment Request</h1>
          <p className="text-xs text-gray-400 mt-0.5">x402 — AlgoVoi</p>
        </div>
      </div>

      <div className="card">
        <p className="text-xs text-gray-400 mb-1">Requesting site</p>
        <p className="text-sm font-medium truncate">{request!.url}</p>
      </div>

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
          <span className="text-xs font-mono text-gray-300 break-all leading-relaxed">{pr.payTo}</span>
        </div>
        {pr.description && (
          <div className="border-t border-surface-3 pt-2">
            <p className="text-xs text-gray-400 mb-1">Description</p>
            <p className="text-sm text-gray-300">{pr.description}</p>
          </div>
        )}
      </div>

      {!isNative && (
        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-3">
          <p className="text-xs text-yellow-400">
            ⚠ This payment uses ASA #{pr.asset}. Ensure your account is opted in to this asset.
          </p>
        </div>
      )}

      {wcWaiting && (
        <div className="bg-surface-2 border border-white/10 rounded-xl p-4 flex flex-col items-center gap-3">
          <Spinner />
          <p className="text-sm text-gray-300 text-center">Open your wallet app and approve the payment</p>
          <p className="text-xs text-gray-500 text-center">Waiting for signature from your connected wallet…</p>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {!wcWaiting && (
        <div className="flex gap-3 mt-auto">
          <button className="btn-secondary flex-1" onClick={reject} disabled={submitting}>Reject</button>
          <button className="btn-primary flex-1" onClick={approve} disabled={submitting}>
            {submitting ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                Sending…
              </span>
            ) : `Pay ${displayAmount} ${assetLabel}`}
          </button>
        </div>
      )}
      {wcWaiting && (
        <div className="mt-auto">
          <button className="btn-secondary w-full" onClick={reject}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────────

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApprovalPage />
  </StrictMode>
);
