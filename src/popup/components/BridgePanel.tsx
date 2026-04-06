import { useState, useEffect } from "react";
import { sendBg } from "../App";
import type { Account } from "@shared/types/wallet";
import type { AccountAsset } from "@shared/types/chain";
import type { ChainId } from "@shared/types/chain";

// Allbridge destination chains for USDC from Algorand
const DEST_CHAINS = [
  { id: "ETH",  label: "Ethereum"  },
  { id: "BSC",  label: "BNB Chain" },
  { id: "SOL",  label: "Solana"    },
  { id: "ARB",  label: "Arbitrum"  },
  { id: "POL",  label: "Polygon"   },
  { id: "AVA",  label: "Avalanche" },
  { id: "OPT",  label: "Optimism"  },
  { id: "BAS",  label: "Base"      },
  { id: "SUI",  label: "SUI"       },
];

// Allbridge chain IDs for deep-link fallback URL
const ALLBRIDGE_CHAIN_ID: Record<string, string> = {
  ETH: "ETH", BSC: "BSC", SOL: "SOL", ARB: "ARB",
  POL: "POL", AVA: "AVA", OPT: "OPT", BAS: "BAS", SUI: "SUI",
};

function allbridgeFallbackUrl(destChain: string): string {
  const t = ALLBRIDGE_CHAIN_ID[destChain] ?? destChain;
  return `https://core.allbridge.io/?f=ALG&ft=USDC&t=${t}&tt=USDC`;
}

// Algorand USDC token address (ASA 31566704)
const ALG_USDC_ADDRESS = "31566704";
const ALG_USDC_ASSET_ID = 31566704;

function formatAtomic(atomic: bigint, decimals: number): string {
  if (decimals === 0) return atomic.toString();
  const d = BigInt(10 ** decimals);
  const int = atomic / d;
  const frac = (atomic % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : `${int}`;
}

export default function BridgePanel({
  activeAccount,
  activeChain,
  assets,
}: {
  activeAccount: Account;
  activeChain:   ChainId;
  balance:       bigint;
  assets:        AccountAsset[];
}) {
  const [destChain,  setDestChain]  = useState("ETH");
  const [amount,     setAmount]     = useState("");
  const [destAddr,   setDestAddr]   = useState("");
  const [estimated,  setEstimated]  = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [executing,  setExecuting]  = useState(false);
  const [txId,       setTxId]       = useState<string | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [fallback,   setFallback]   = useState<string | null>(null);

  // Only supported on Algorand
  const unsupported = activeChain !== "algorand";

  // Available USDC balance
  const usdcAsset = assets.find((a) => a.assetId === ALG_USDC_ASSET_ID);
  const usdcBalance = usdcAsset?.amount ?? 0n;
  const usdcDisplay = formatAtomic(usdcBalance, 6);

  // Fetch estimate when amount or dest chain changes
  useEffect(() => {
    if (!amount || parseFloat(amount) <= 0 || unsupported) {
      setEstimated(null);
      return;
    }
    const timer = setTimeout(async () => {
      setEstimating(true);
      try {
        const res = await sendBg<{ result?: { estimatedReceive?: string }; error?: string }>({
          type: "MCP_TOOL_CALL",
          tool: "allbridge_bridge_txn",
          params: {
            fromAddress:          activeAccount.address,
            toAddress:            activeAccount.address, // placeholder for estimate
            sourceTokenAddress:   ALG_USDC_ADDRESS,
            destinationChain:     destChain,
            destinationTokenSymbol: "USDC",
            amount:               amount.trim(),
          },
        });
        if (res?.result?.estimatedReceive) {
          setEstimated(res.result.estimatedReceive + " USDC");
        } else {
          setEstimated(null);
        }
      } catch {
        setEstimated(null);
      } finally {
        setEstimating(false);
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [amount, destChain, unsupported, activeAccount.address]);

  async function handleBridge() {
    if (!amount.trim() || !/^\d+(\.\d+)?$/.test(amount.trim()) || parseFloat(amount) <= 0) {
      setError("Enter a valid amount");
      return;
    }
    if (!destAddr.trim()) {
      setError("Enter a destination address");
      return;
    }
    if (activeAccount.type === "walletconnect") {
      setError("Bridge requires a mnemonic account");
      return;
    }

    setExecuting(true);
    setError(null);
    setTxId(null);

    const keepAlive = setInterval(() => void sendBg({ type: "KEEP_ALIVE" }), 30_000);
    try {
      const result = await sendBg<{ txId: string }>({
        type:                 "ALLBRIDGE_EXECUTE",
        fromAddress:          activeAccount.address,
        toAddress:            destAddr.trim(),
        sourceTokenAddress:   ALG_USDC_ADDRESS,
        destinationChain:     destChain,
        destinationTokenSymbol: "USDC",
        amount:               amount.trim(),
      });
      setTxId(result.txId);
      setAmount("");
      setEstimated(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Bridge failed.";
      // Show fallback link so user can complete on Allbridge website
      setError(`${msg} Use the fallback link below to bridge on allbridge.io directly.`);
      setFallback(allbridgeFallbackUrl(destChain));
    } finally {
      clearInterval(keepAlive);
      setExecuting(false);
    }
  }

  if (unsupported) {
    return (
      <div className="flex flex-col items-center justify-center h-32 gap-2 text-center">
        <span className="text-gray-400 text-xs">Allbridge is only available on Algorand.</span>
        <span className="text-gray-500 text-xs">Switch to Algorand to bridge USDC.</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">

      {/* Route header */}
      <div className="flex items-center justify-between text-xs px-1">
        <span className="font-semibold text-white">Algorand USDC</span>
        <span className="text-algo">→</span>
        <select
          className="bg-surface-1 text-white text-xs rounded-lg px-2 py-1 outline-none cursor-pointer"
          value={destChain}
          onChange={(e) => { setDestChain(e.target.value); setEstimated(null); }}
        >
          {DEST_CHAINS.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
        <span className="text-gray-500 text-xs ml-1">via Allbridge</span>
      </div>

      {/* Amount */}
      <div className="bg-surface-2 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-gray-400">USDC amount</span>
          <span className="text-xs text-gray-500">Bal: {usdcDisplay}</span>
        </div>
        <div className="flex gap-2">
          <span className="bg-surface-1 text-xs rounded-lg px-2 py-1.5 text-gray-300">USDC</span>
          <input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setTxId(null); setError(null); setFallback(null); }}
            className="flex-1 bg-surface-1 text-white text-sm rounded-lg px-3 py-1.5 outline-none [appearance:textfield]"
          />
          <button
            onClick={() => { setAmount(usdcDisplay); setTxId(null); setError(null); setFallback(null); }}
            className="text-xs text-algo hover:underline px-1"
          >
            Max
          </button>
        </div>
      </div>

      {/* Destination address */}
      <div className="bg-surface-2 rounded-xl p-2.5">
        <span className="text-xs text-gray-400 block mb-1.5">
          Destination ({DEST_CHAINS.find((c) => c.id === destChain)?.label})
        </span>
        <input
          type="text"
          placeholder="Paste destination address…"
          value={destAddr}
          onChange={(e) => { setDestAddr(e.target.value); setTxId(null); setError(null); setFallback(null); }}
          className="w-full bg-surface-1 text-white text-xs rounded-lg px-3 py-1.5 outline-none font-mono"
          spellCheck={false}
        />
      </div>

      {/* Estimate */}
      {(estimating || estimated) && (
        <div className="flex justify-between text-xs px-1 text-gray-400">
          <span>You receive (~)</span>
          <span className="text-algo">{estimating ? "…" : estimated}</span>
        </div>
      )}

      {/* Error + fallback */}
      {error && (
        <div className="text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-1.5">
          {error}
        </div>
      )}
      {fallback && (
        <a
          href={fallback}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center text-xs text-algo underline py-1"
        >
          Open Allbridge.io to bridge manually →
        </a>
      )}

      {/* Execute */}
      <button
        onClick={handleBridge}
        disabled={executing || !amount || !destAddr}
        className="w-full py-2.5 rounded-xl bg-algo text-black text-sm font-bold hover:bg-algo/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {executing ? "Bridging…" : `Bridge USDC → ${DEST_CHAINS.find((c) => c.id === destChain)?.label}`}
      </button>

      {/* Success */}
      {txId && (
        <div className="text-xs text-green-400 bg-green-400/10 rounded-lg px-3 py-1.5 break-all">
          Bridged! TX: {txId}
        </div>
      )}
    </div>
  );
}
