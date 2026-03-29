import { StrictMode, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../popup/index.css";
import { formatAmount } from "@shared/utils/format";
import { CHAINS } from "@shared/constants";
import { signTransactionWithWC } from "@shared/utils/wc-sign";
import type { PendingX402Request } from "@shared/types/x402";
import type { PendingApproval, PendingSignTxnsApproval, PendingSignBytesApproval, PendingEnvoiApproval, PendingMppApproval, TxnSummary } from "@shared/types/approval";
import type { PendingAp2Approval } from "@shared/types/ap2";
import type { PendingAgentSignRequest } from "@shared/types/agent";
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

// ── Suppress benign WC "No matching key" rejections ──────────────────────
// (Same handler as popup/index.tsx — approval popup has its own JS context)
window.addEventListener("unhandledrejection", (event) => {
  const msg: string =
    (event.reason as { message?: string } | null)?.message ??
    String(event.reason ?? "");
  if (msg.includes("No matching key")) {
    event.preventDefault();
  }
});

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
const KIND       = _params.get("kind") ?? "";       // "sign_txns" | "sign_bytes" | "envoi_payment" | "mpp_charge" | "ap2_payment" | "agent_sign" | ""

// ── Root component ────────────────────────────────────────────────────────────

function ApprovalPage() {
  if (!REQUEST_ID) {
    return <ErrorScreen message="Missing requestId parameter" />;
  }
  // Route by kind — empty kind = legacy x402 flow
  if (KIND === "sign_txns")     return <SignTxnsPage    requestId={REQUEST_ID} />;
  if (KIND === "sign_bytes")    return <SignBytesPage   requestId={REQUEST_ID} />;
  if (KIND === "envoi_payment") return <EnvoiPage       requestId={REQUEST_ID} />;
  if (KIND === "mpp_charge")    return <MppPage         requestId={REQUEST_ID} />;
  if (KIND === "ap2_payment")   return <Ap2Page         requestId={REQUEST_ID} />;
  if (KIND === "agent_sign")    return <AgentSignPage   requestId={REQUEST_ID} />;
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

  const typeLabel = summary.applType ? `appl · ${summary.applType}` : summary.type;
  const isDangerAppl = summary.applType === "UpdateApp" || summary.applType === "DeleteApp";

  return (
    <div className="flex flex-col gap-0.5 py-1.5 border-b border-surface-3 last:border-0">
      <div className="flex justify-between items-center">
        <span className="text-xs font-mono text-gray-400">Txn {index + 1}</span>
        <span className={`text-xs font-semibold uppercase tracking-wider ${isDangerAppl ? "text-red-400" : "text-algo"}`}>
          {typeLabel}
        </span>
      </div>
      {summary.sender && (
        <p className="text-[10px] font-mono text-gray-500 truncate">From: {summary.sender}</p>
      )}
      {summary.receiver && (
        <p className="text-[10px] font-mono text-gray-500 truncate">To: {summary.receiver}</p>
      )}
      {summary.amount && (
        <p className="text-xs font-semibold text-white">{summary.amount}</p>
      )}

      {/* ── Dangerous-field warnings ─────────────────────────────────────── */}
      {summary.blind && (
        <p className="text-[10px] text-yellow-400 bg-yellow-900/30 rounded px-1.5 py-0.5 mt-0.5">
          ⚠ Transaction could not be decoded — contents unknown
        </p>
      )}
      {summary.rekeyTo && (
        <p className="text-[10px] text-red-300 bg-red-900/40 rounded px-1.5 py-0.5 mt-0.5 break-all">
          🔑 REKEY: permanently transfers account control to {summary.rekeyTo}
        </p>
      )}
      {summary.closeRemainderTo && (
        <p className="text-[10px] text-red-300 bg-red-900/40 rounded px-1.5 py-0.5 mt-0.5 break-all">
          ⚠ CLOSE ACCOUNT: ALL remaining ALGO sent to {summary.closeRemainderTo}
        </p>
      )}
      {summary.assetCloseTo && (
        <p className="text-[10px] text-red-300 bg-red-900/40 rounded px-1.5 py-0.5 mt-0.5 break-all">
          ⚠ CLOSE ASSET: ALL remaining balance sent to {summary.assetCloseTo}
        </p>
      )}
      {summary.clawbackFrom && (
        <p className="text-[10px] text-red-300 bg-red-900/40 rounded px-1.5 py-0.5 mt-0.5 break-all">
          🚨 CLAWBACK: forcibly moves ASA from {summary.clawbackFrom} — funds taken from another account
        </p>
      )}
      {summary.feeMicroalgos !== undefined && summary.feeMicroalgos > 10_000 && (
        <p className="text-[10px] text-yellow-400 bg-yellow-900/30 rounded px-1.5 py-0.5 mt-0.5">
          ⚠ High fee: {(summary.feeMicroalgos / 1_000_000).toFixed(6)} (fee {summary.feeMicroalgos.toLocaleString()} µ — {Math.round(summary.feeMicroalgos / 1_000)}× minimum)
        </p>
      )}
      {summary.shortValidityWindow && (
        <p className="text-[10px] text-orange-400 bg-orange-900/30 rounded px-1.5 py-0.5 mt-0.5">
          ⚠ Very short validity window — transaction expires in seconds. Do not approve under time pressure.
        </p>
      )}
      {summary.hasLease && (
        <p className="text-[10px] text-yellow-400 bg-yellow-900/30 rounded px-1.5 py-0.5 mt-0.5">
          ⚠ LEASE: blocks replacement transactions from this sender until expiry.
        </p>
      )}
      {summary.freezeTarget && (
        <p className="text-[10px] text-red-300 bg-red-900/40 rounded px-1.5 py-0.5 mt-0.5 break-all">
          🧊 ASSET {summary.freezing ? "FREEZE" : "UNFREEZE"}: {summary.freezeTarget}
        </p>
      )}
      {summary.keyregOnline !== undefined && (
        <p className="text-[10px] text-yellow-400 bg-yellow-900/30 rounded px-1.5 py-0.5 mt-0.5">
          🔑 KEY REGISTRATION: account going {summary.keyregOnline ? "ONLINE (consensus participation enabled)" : "OFFLINE (consensus participation disabled)"}
        </p>
      )}
      {summary.note && (
        <p className="text-[10px] text-gray-400 font-mono bg-surface-2 rounded px-1.5 py-0.5 mt-0.5 truncate">
          Note: {summary.note}
        </p>
      )}
    </div>
  );
}

function SignTxnsPage({ requestId }: { requestId: string }) {
  const [approval, setApproval] = useState<PendingSignTxnsApproval | null>(null);
  const [loading,   setLoading]  = useState(true);
  const [approving, setApproving] = useState(false);
  const [error,     setError]    = useState("");
  const [blindAck,  setBlindAck] = useState(false);

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

  const hasBlind = approval.txnSummaries.some((s) => s.blind);
  const approveDisabled = hasBlind && !blindAck;

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

      {/* Atomic group notice */}
      {approval.txns.length > 1 && (
        <div className="bg-blue-900/20 border border-blue-700/30 rounded-xl p-3">
          <p className="text-xs text-blue-300">
            ℹ {approval.txns.length} transactions — these execute atomically: all succeed or all fail together.
          </p>
        </div>
      )}

      <div className="card flex flex-col gap-1">
        <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">
          Transactions ({toSign} to sign, {approval.txns.length} total)
        </p>
        {approval.txnSummaries.map((s, i) => (
          <TxnRow key={i} summary={s} index={i} />
        ))}
      </div>

      {/* Blind-sign acknowledgment gate */}
      {hasBlind && (
        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-3 flex flex-col gap-2">
          <p className="text-xs text-yellow-300 font-semibold">⚠ One or more transactions could not be decoded</p>
          {approval.txns.map((b64, i) =>
            approval.txnSummaries[i]?.blind ? (
              <div key={i} className="flex flex-col gap-1">
                <p className="text-[10px] text-yellow-400">Transaction {i + 1} raw bytes (hex):</p>
                <p className="text-[10px] font-mono text-gray-400 bg-surface-2 rounded p-1.5 break-all leading-relaxed">
                  {(() => {
                    try {
                      const bin = atob(b64);
                      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
                      return Array.from(bytes.slice(0, 96)).map((b) => b.toString(16).padStart(2, "0")).join(" ")
                        + (bytes.length > 96 ? ` … (${bytes.length} bytes total)` : "");
                    } catch { return "(could not decode)"; }
                  })()}
                </p>
              </div>
            ) : null
          )}
          <label className="flex items-start gap-2 cursor-pointer mt-1">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              checked={blindAck}
              onChange={(e) => setBlindAck(e.target.checked)}
            />
            <span className="text-xs text-yellow-300">
              I have reviewed the raw bytes above and understand I am signing an undecodable transaction.
            </span>
          </label>
        </div>
      )}

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
        disabled={approveDisabled}
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

      <div className="bg-orange-900/30 border border-orange-700/50 rounded-xl p-3">
        <p className="text-xs text-orange-300">
          ⚠ This payment will be broadcast to the Voi blockchain and <strong>cannot be reversed</strong>.
          Only approve if you trust the enVoi name service and intended to resolve this name.
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

// ── MPP avm charge page ───────────────────────────────────────────────────────

function MppPage({ requestId }: { requestId: string }) {
  const [approval, setApproval] = useState<PendingMppApproval | null>(null);
  const [loading,      setLoading]     = useState(true);
  const [approving,    setApproving]   = useState(false);
  const [wcWaiting,    setWcWaiting]   = useState(false);
  const [wcConfirming, setWcConfirming] = useState(false);
  const [error,        setError]       = useState("");

  useEffect(() => {
    sendBg<{ request: PendingMppApproval | null }>({ type: "MPP_GET_PENDING", requestId })
      .then(({ request: req }) => {
        if (!req) setError("Payment request not found or already settled");
        else setApproval(req);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [requestId]);

  async function approve() {
    setApproving(true);
    setError("");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await sendBg<any>({ type: "MPP_APPROVE", requestId });
      if (result.needsWcSign) {
        setApproving(false);
        setWcWaiting(true);
        try {
          const signedBytes = await signTransactionWithWC(
            result.sessionTopic,
            result.chain,
            result.unsignedTxnB64,
            result.signerAddress
          );
          setWcWaiting(false);
          setWcConfirming(true);
          const signedTxnB64 = btoa(String.fromCharCode(...signedBytes));
          await sendBg({ type: "MPP_WC_SIGNED", requestId, signedTxnB64 });
          window.close();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Wallet rejected the payment");
          setWcWaiting(false);
          setWcConfirming(false);
        }
        return;
      }
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Payment failed");
      setApproving(false);
    }
  }

  async function reject() {
    await sendBg({ type: "MPP_REJECT", requestId }).catch(() => {});
    window.close();
  }

  if (loading) return <div className="flex items-center justify-center h-screen"><Spinner /></div>;
  if (!approval) return <ErrorScreen message={error || "Request not found"} />;

  const displayAmount = formatAmount(
    /^\d+$/.test(String(approval.amount)) ? BigInt(approval.amount) : 0n,
    approval.decimals
  );
  const networkLabel = approval.network === "algorand" ? "Algorand" : "Voi";
  const networkColor = approval.network === "algorand" ? "text-algo" : "text-voi";

  return (
    <div className="flex flex-col min-h-screen p-5 gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-purple-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">M</div>
        <div>
          <h1 className="text-base font-bold leading-none">MPP Payment</h1>
          <p className="text-xs text-gray-400 mt-0.5">Machine Payments Protocol · avm — AlgoVoi</p>
        </div>
      </div>

      <div className="card">
        <p className="text-xs text-gray-400 mb-1">Requesting server</p>
        <p className="text-sm font-medium truncate">{approval.realm}</p>
        {approval.url !== approval.realm && (
          <p className="text-[10px] text-gray-500 truncate mt-0.5">{approval.url}</p>
        )}
      </div>

      <div className="card flex flex-col gap-3">
        <p className="text-xs text-gray-400 uppercase tracking-wider">Payment Details</p>
        <div className="flex justify-between items-start">
          <span className="text-sm text-gray-400">Amount</span>
          <div className="text-right">
            <span className="text-xl font-bold text-white">{displayAmount}</span>
            <span className="text-sm text-gray-400 ml-1.5">{approval.currencyLabel}</span>
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-gray-400">Network</span>
          <span className={`text-sm font-medium ${networkColor}`}>{networkLabel}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-gray-400">Pay to</span>
          <span
            className="text-xs font-mono text-gray-300 break-all leading-relaxed"
            title={approval.recipient}
          >
            {approval.recipient.slice(0, 8)}…{approval.recipient.slice(-8)}
          </span>
        </div>
        {approval.description && (
          <div className="border-t border-surface-3 pt-2">
            <p className="text-xs text-gray-400 mb-1">Description</p>
            <p className="text-sm text-gray-300">{approval.description}</p>
          </div>
        )}
        <div className="border-t border-surface-3 pt-2 flex justify-between text-[10px] text-gray-500">
          <span>Challenge ID</span>
          <span className="font-mono truncate max-w-[180px]">{approval.challengeId}</span>
        </div>
      </div>

      <div className="bg-orange-900/30 border border-orange-700/50 rounded-xl p-3">
        <p className="text-xs text-orange-300">
          ⚠ This payment will be broadcast to the {networkLabel} blockchain and{" "}
          <strong>cannot be reversed</strong>. Only approve if you trust{" "}
          <strong>{approval.realm}</strong>.
        </p>
      </div>

      {wcWaiting && (
        <div className="bg-blue-900/30 border border-blue-700/50 rounded-xl p-4 flex flex-col items-center gap-2 text-center">
          <Spinner size={4} />
          <p className="text-sm text-blue-300 font-medium">Open your wallet app on your phone</p>
          <p className="text-xs text-gray-400">Extension payments don't send push notifications — open Defly / Pera / Lute and look for the pending signing request.</p>
        </div>
      )}

      {wcConfirming && (
        <div className="bg-green-900/30 border border-green-700/50 rounded-xl p-3 flex items-center gap-2">
          <Spinner size={4} />
          <p className="text-sm text-green-300">Confirming on-chain…</p>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <ApproveRejectBar
        approveLabel={`Pay ${displayAmount} ${approval.currencyLabel}`}
        rejectLabel="Reject"
        onApprove={approve}
        onReject={reject}
        approving={approving}
        disabled={approving || wcWaiting || wcConfirming}
      />
    </div>
  );
}

// ── AP2 payment credential page ───────────────────────────────────────────────

function Ap2Page({ requestId }: { requestId: string }) {
  const [approval, setApproval] = useState<PendingAp2Approval | null>(null);
  const [loading,   setLoading]  = useState(true);
  const [approving, setApproving] = useState(false);
  const [error,     setError]    = useState("");
  const [countdown, setCountdown] = useState<number | null>(null);

  useEffect(() => {
    sendBg<{ request: PendingAp2Approval | null }>({ type: "AP2_GET_PENDING", requestId })
      .then(({ request: req }) => {
        if (!req) setError("AP2 payment request not found or already settled");
        else {
          setApproval(req);
          // Start expiry countdown if present
          if (req.expiry) {
            const expiresAt = new Date(req.expiry).getTime();
            if (!isNaN(expiresAt)) {
              const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
              setCountdown(remaining);
            }
          }
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [requestId]);

  // Countdown ticker
  useEffect(() => {
    if (countdown === null || countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c === null || c <= 1) { clearInterval(timer); return 0; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown !== null]);

  async function approve() {
    setApproving(true);
    setError("");
    try {
      await sendBg({ type: "AP2_APPROVE", requestId });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Credential signing failed");
      setApproving(false);
    }
  }

  async function reject() {
    await sendBg({ type: "AP2_REJECT", requestId }).catch(() => {});
    window.close();
  }

  if (loading) return <div className="flex items-center justify-center h-screen"><Spinner /></div>;
  if (!approval) return <ErrorScreen message={error || "Request not found"} />;

  const networkLabel = approval.network === "algorand" ? "Algorand" : "Voi";
  const networkColor = approval.network === "algorand" ? "text-algo" : "text-voi";
  const expired = countdown !== null && countdown <= 0;

  return (
    <div className="flex flex-col min-h-screen p-5 gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-sm">A2</div>
        <div>
          <h1 className="text-base font-bold leading-none">AP2 Payment Credential</h1>
          <p className="text-xs text-gray-400 mt-0.5">Agent Payments Protocol — AlgoVoi</p>
        </div>
      </div>

      {/* Merchant / source */}
      <div className="card">
        <p className="text-xs text-gray-400 mb-1">Requesting page</p>
        <p className="text-sm font-medium truncate">{approval.url}</p>
        {approval.merchant_id && (
          <p className="text-xs text-gray-500 truncate mt-0.5">Merchant: {approval.merchant_id}</p>
        )}
      </div>

      {/* Cart items */}
      <div className="card flex flex-col gap-2">
        <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">Cart Items</p>
        {approval.items.map((item, i) => (
          <div key={i} className="flex justify-between items-start border-b border-surface-3 pb-1.5 last:border-0 last:pb-0">
            <span className="text-sm text-gray-300 flex-1 mr-2">{item.label}</span>
            <span className="text-sm font-semibold text-white shrink-0">
              {item.amount.value} {item.amount.currency}
            </span>
          </div>
        ))}
        <div className="flex justify-between items-center border-t border-surface-2 pt-2 mt-1">
          <span className="text-sm text-gray-400 font-semibold">Total</span>
          <div className="text-right">
            <span className="text-xl font-bold text-white">{approval.total.value}</span>
            <span className="text-sm text-gray-400 ml-1.5">{approval.total.currency}</span>
          </div>
        </div>
      </div>

      {/* Network + signer */}
      <div className="card flex flex-col gap-2">
        <div className="flex justify-between">
          <span className="text-sm text-gray-400">Network</span>
          <span className={`text-sm font-medium ${networkColor}`}>{networkLabel}</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-gray-400">Signing address</span>
          <span className="text-xs font-mono text-gray-300 break-all leading-relaxed"
            title={approval.address}>
            {approval.address.slice(0, 8)}…{approval.address.slice(-8)}
          </span>
        </div>
        <div className="flex justify-between text-[10px] text-gray-500">
          <span>Transaction ID</span>
          <span className="font-mono truncate max-w-[200px]">{approval.transaction_id}</span>
        </div>
      </div>

      {/* Expiry countdown */}
      {countdown !== null && (
        <div className={`border rounded-xl p-3 ${
          expired
            ? "bg-red-900/30 border-red-700/50"
            : countdown < 60
            ? "bg-orange-900/30 border-orange-700/50"
            : "bg-surface-2 border-white/10"
        }`}>
          <p className={`text-xs ${expired ? "text-red-300" : countdown < 60 ? "text-orange-300" : "text-gray-400"}`}>
            {expired
              ? "Cart mandate has expired — this credential will be rejected by the merchant."
              : `Cart expires in ${countdown}s`}
          </p>
        </div>
      )}

      {/* Security warning */}
      <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-3">
        <p className="text-xs text-yellow-300">
          ⚠ Signing this credential authorizes payment on your behalf.{" "}
          <strong>No AVM transaction is submitted now</strong> — the merchant/agent handles
          settlement separately using this signed credential.
          Only approve if you trust <strong>{approval.merchant_id ?? approval.url}</strong>.
        </p>
      </div>

      {approval.isWalletConnect && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
          <p className="text-xs text-red-300">
            ⚠ <strong>WalletConnect accounts cannot sign AP2 credentials.</strong>{" "}
            AP2 requires ed25519 byte signing which WalletConnect mobile wallets do not support.
            Switch to a vault (mnemonic) account in AlgoVoi settings to use AP2.
          </p>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <ApproveRejectBar
        approveLabel="Sign credential"
        rejectLabel="Reject"
        onApprove={approve}
        onReject={reject}
        approving={approving}
        disabled={expired || (approval?.isWalletConnect ?? false)}
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
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3 space-y-1">
          <p className="text-sm text-red-400">{error}</p>
          {error.includes("no longer active") || error.includes("disconnected") || error.includes("ping") ? (
            <p className="text-xs text-gray-400">
              Open AlgoVoi → remove the WalletConnect account → tap <strong>+ Connect</strong> to re-pair. Your account won't be deleted.
            </p>
          ) : null}
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

// ── Agent Sign page ───────────────────────────────────────────────────────────

function AgentSignPage({ requestId }: { requestId: string }) {
  const [request,  setRequest]  = useState<PendingAgentSignRequest | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [approving, setApproving] = useState(false);
  const [error,    setError]    = useState("");
  const [blindAck, setBlindAck] = useState(false);

  useEffect(() => {
    sendBg<{ request: PendingAgentSignRequest | null }>({ type: "W3W_AGENT_SIGN_GET_PENDING", requestId })
      .then(({ request: req }) => {
        if (!req) setError("Agent signing request not found or already settled");
        else setRequest(req);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [requestId]);

  async function approve() {
    setApproving(true);
    setError("");
    try {
      await sendBg({ type: "W3W_AGENT_SIGN_APPROVE", requestId });
      window.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Signing failed");
      setApproving(false);
    }
  }

  async function reject() {
    await sendBg({ type: "W3W_AGENT_SIGN_REJECT", requestId }).catch(() => {});
    window.close();
  }

  if (loading) return <div className="flex items-center justify-center h-screen"><Spinner /></div>;
  if (!request) return <ErrorScreen message={error || "Request not found"} />;

  const chainLabel = request.chain === "algorand" ? "Algorand" : "Voi";
  const chainColor = request.chain === "algorand" ? "text-algo" : "text-voi";
  const txCount = request.txns.length;
  const summaries = request.txnSummaries ?? [];
  const hasBlind = summaries.some((s) => s.blind);
  const approveDisabled = (hasBlind && !blindAck) || approving;

  return (
    <div className="flex flex-col min-h-screen p-5 gap-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-blue-500 rounded-lg flex items-center justify-center text-white font-bold text-sm">AI</div>
        <div>
          <h1 className="text-base font-bold leading-none">AI Agent Sign Request</h1>
          <p className="text-xs text-gray-400 mt-0.5">WalletConnect Web3Wallet — AlgoVoi</p>
        </div>
      </div>

      {/* Agent identity */}
      <div className="card">
        <p className="text-xs text-gray-400 mb-1">AI Agent</p>
        <p className="text-sm font-medium truncate">{request.agentName || "Unknown Agent"}</p>
        {request.agentUrl && (
          <p className="text-[10px] text-gray-500 truncate mt-0.5">{request.agentUrl}</p>
        )}
      </div>

      {/* Chain + transaction count */}
      <div className="card flex flex-col gap-2">
        <div className="flex justify-between">
          <span className="text-sm text-gray-400">Chain</span>
          <span className={`text-sm font-medium ${chainColor}`}>{chainLabel}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-sm text-gray-400">Transactions</span>
          <span className="text-sm font-medium text-white">{txCount}</span>
        </div>
      </div>

      {/* Per-txn details — use pre-decoded summaries from background */}
      {summaries.length > 0 && (
        <div className="card flex flex-col gap-1">
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-1">
            Transactions ({txCount})
          </p>
          {summaries.map((s, i) => <TxnRow key={i} summary={s} index={i} />)}
        </div>
      )}

      {/* Blind ack gate — required when any txn could not be decoded */}
      {hasBlind && (
        <label className="flex items-start gap-2 cursor-pointer bg-yellow-900/20 border border-yellow-700/40 rounded-xl p-3">
          <input
            type="checkbox"
            checked={blindAck}
            onChange={(e) => setBlindAck(e.target.checked)}
            className="mt-0.5 accent-yellow-400"
          />
          <span className="text-xs text-yellow-300">
            I understand that one or more transactions could not be decoded and I am signing them without being able to verify their contents.
          </span>
        </label>
      )}

      {/* Security warnings */}
      <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
        <p className="text-xs text-red-300 font-semibold mb-1">Signing on behalf of an AI agent</p>
        <p className="text-xs text-red-300">
          Verify the transactions carefully. The agent cannot access your private keys —
          AlgoVoi signs internally — but only approve requests from agents you trust.
        </p>
      </div>

      {!request.agentUrl && (
        <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-3">
          <p className="text-xs text-yellow-300">
            This agent did not provide a URL. Proceed with caution.
          </p>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      <ApproveRejectBar
        approveLabel={`Sign ${txCount} transaction${txCount !== 1 ? "s" : ""}`}
        rejectLabel="Reject"
        onApprove={approve}
        onReject={reject}
        approving={approveDisabled}
      />
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────────

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApprovalPage />
  </StrictMode>
);
