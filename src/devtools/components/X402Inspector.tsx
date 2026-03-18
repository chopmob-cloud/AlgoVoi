/**
 * x402 Inspector — captures and displays all x402 payment requests
 * observed in the current tab's network activity.
 */

import { useState, useEffect } from "react";
import { formatAmount, timeAgo } from "@shared/utils/format";
import type { PaymentRequirements } from "@shared/types/x402";

interface CapturedRequest {
  id: string;
  url: string;
  timestamp: number;
  requirements: PaymentRequirements;
  status: "pending" | "approved" | "rejected";
}

export default function X402Inspector() {
  const [captured, setCaptured] = useState<CapturedRequest[]>([]);
  const [selected, setSelected] = useState<CapturedRequest | null>(null);

  // Listen for x402 events from the background (via devtools inspected window)
  useEffect(() => {
    function onMessage(msg: { type: string; payload?: unknown }) {
      if (msg.type === "X402_CAPTURED") {
        const req = msg.payload as CapturedRequest;
        setCaptured((prev) => [req, ...prev].slice(0, 100)); // cap at 100
      }
    }
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  function clearAll() {
    setCaptured([]);
    setSelected(null);
  }

  const pr = selected?.requirements;

  return (
    <div className="flex h-full">
      {/* Request list */}
      <div className="w-80 border-r border-surface-2 flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b border-surface-2">
          <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
            x402 Requests ({captured.length})
          </span>
          <button onClick={clearAll} className="text-xs text-gray-500 hover:text-white">
            Clear
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {captured.length === 0 ? (
            <div className="text-xs text-gray-500 text-center p-6">
              No x402 requests captured yet.
              <br />
              Browse a site that uses x402 payments.
            </div>
          ) : (
            captured.map((req) => (
              <button
                key={req.id}
                onClick={() => setSelected(req)}
                className={`w-full text-left px-3 py-2.5 border-b border-surface-2/50 hover:bg-surface-1 transition-colors ${
                  selected?.id === req.id ? "bg-surface-2" : ""
                }`}
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs font-mono text-gray-300 truncate max-w-[180px]">
                    {new URL(req.url).pathname}
                  </span>
                  <StatusBadge status={req.status} />
                </div>
                <div className="text-[10px] text-gray-500">{timeAgo(req.timestamp)}</div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Detail pane */}
      <div className="flex-1 overflow-y-auto p-4">
        {!selected ? (
          <div className="text-xs text-gray-500 text-center mt-20">
            Select a request to inspect
          </div>
        ) : (
          <div className="flex flex-col gap-4 max-w-2xl">
            <div>
              <h2 className="text-sm font-semibold mb-1">x402 Payment Request</h2>
              <p className="text-xs text-gray-400 font-mono break-all">{selected.url}</p>
            </div>

            <DetailSection title="PaymentRequirements">
              <Row label="scheme" value={pr!.scheme} />
              <Row label="network" value={pr!.network} highlight />
              <Row
                label="maxAmountRequired"
                value={`${formatAmount(BigInt(pr!.maxAmountRequired), 6)} (${pr!.maxAmountRequired} µ)`}
              />
              <Row label="asset" value={pr!.asset === "0" ? "Native coin" : `ASA ${pr!.asset}`} />
              <Row label="payTo" value={pr!.payTo} mono />
              <Row label="description" value={pr!.description || "—"} />
              <Row label="maxTimeoutSeconds" value={String(pr!.maxTimeoutSeconds)} />
              <Row label="resource" value={pr!.resource} mono />
            </DetailSection>

            {pr!.extra && (
              <DetailSection title="Extra">
                <pre className="text-xs text-gray-300 bg-surface-2 rounded-lg p-3 overflow-x-auto">
                  {JSON.stringify(pr!.extra, null, 2)}
                </pre>
              </DetailSection>
            )}

            <DetailSection title="Raw Header">
              <pre className="text-[10px] text-gray-400 bg-surface-2 rounded-lg p-3 overflow-x-auto break-all whitespace-pre-wrap">
                {JSON.stringify(pr, null, 2)}
              </pre>
            </DetailSection>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: CapturedRequest["status"] }) {
  const colors = {
    pending: "bg-yellow-500/20 text-yellow-400",
    approved: "bg-green-500/20 text-green-400",
    rejected: "bg-red-500/20 text-red-400",
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${colors[status]}`}>
      {status}
    </span>
  );
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-1 rounded-xl p-3">
      <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-2">{title}</p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-xs text-gray-500 shrink-0">{label}</span>
      <span
        className={`text-xs text-right break-all ${mono ? "font-mono" : ""} ${highlight ? "text-algo" : "text-gray-300"}`}
      >
        {value}
      </span>
    </div>
  );
}
