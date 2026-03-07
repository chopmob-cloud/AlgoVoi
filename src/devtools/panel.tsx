import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../popup/index.css";
import TxnInspector from "./components/TxnInspector";
import X402Inspector from "./components/X402Inspector";
import BazaarPanel from "./components/BazaarPanel";

type Tab = "txn" | "x402" | "bazaar";

function DevToolsPanel() {
  const [tab, setTab] = useState<Tab>("x402");

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-2">
        <div className="w-7 h-7 bg-algo rounded-md flex items-center justify-center text-black text-xs font-bold">
          AV
        </div>
        <h1 className="text-sm font-semibold">AlgoVoi Developer Tools</h1>
        <div className="ml-auto flex gap-1">
          {(["x402", "txn", "bazaar"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-xs px-3 py-1.5 rounded-md capitalize transition-colors ${
                tab === t
                  ? "bg-algo text-black font-semibold"
                  : "text-gray-400 hover:text-white hover:bg-surface-2"
              }`}
            >
              {t === "x402" ? "x402 Inspector" : t === "txn" ? "Txn Decoder" : "Bazaar"}
            </button>
          ))}
        </div>
      </div>

      {/* Panel content */}
      <div className="flex-1 overflow-hidden">
        {tab === "x402" && <X402Inspector />}
        {tab === "txn" && <TxnInspector />}
        {tab === "bazaar" && <BazaarPanel />}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DevToolsPanel />
  </StrictMode>
);
