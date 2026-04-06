import { useState } from "react";
import { sendBg } from "../App";
import type { Account } from "@shared/types/wallet";
import type { AccountAsset } from "@shared/types/chain";
import type { ChainId } from "@shared/types/chain";
import { BRIDGE_TOKEN_PAIRS } from "../../background/bridge-handler";

// Supported tokens per chain — USDC/aUSDC only
const CHAIN_TOKENS: Record<ChainId, { id: number; symbol: string; decimals: number }[]> = {
  voi:      [{ id: 302190,   symbol: "aUSDC", decimals: 6 }],
  algorand: [{ id: 31566704, symbol: "USDC",  decimals: 6 }],
};

const CHAIN_LABEL: Record<ChainId, string> = {
  voi:      "Voi",
  algorand: "Algorand",
};

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
  balance,
  assets,
}: {
  activeAccount: Account;
  activeChain:   ChainId;
  balance:       bigint;
  assets:        AccountAsset[];
}) {
  const destChain = activeChain === "voi" ? "algorand" : "voi";

  const tokens  = CHAIN_TOKENS[activeChain];
  const [tokenIdx,  setTokenIdx]  = useState(0);
  const [amount,    setAmount]    = useState("");
  const [destAddr,  setDestAddr]  = useState("");
  const [executing, setExecuting] = useState(false);
  const [txId,      setTxId]      = useState<string | null>(null);
  const [error,     setError]     = useState<string | null>(null);

  const token = tokens[tokenIdx];
  const pairKey = `${activeChain}:${token.id}`;
  const pair = BRIDGE_TOKEN_PAIRS[pairKey];

  // Available balance for selected token (ASA only — native tokens not supported)
  const rawAvailable = assets.find((a) => a.assetId === token.id)?.amount ?? 0n;
  const availableAtomic = rawAvailable;
  const availableDisplay = formatAtomic(availableAtomic, token.decimals);

  // Fee preview (0.1%)
  let feeDisplay = "—";
  let receiveDisplay = "—";
  const amtNum = parseFloat(amount);
  if (amount && !isNaN(amtNum) && amtNum > 0) {
    const fee    = amtNum * 0.001;
    const recv   = amtNum - fee;
    feeDisplay   = fee.toFixed(token.decimals > 4 ? 4 : token.decimals) + " " + token.symbol;
    receiveDisplay = recv.toFixed(token.decimals > 4 ? 4 : token.decimals) + " " + (pair?.destSymbol ?? "");
  }

  function reset() {
    setAmount("");
    setTxId(null);
    setError(null);
  }

  async function handleBridge() {
    // XXI-7: reject scientific notation and non-standard decimal formats
    if (!amount.trim() || !/^\d+(\.\d+)?$/.test(amount.trim()) || parseFloat(amount) <= 0) {
      setError("Enter a valid amount");
      return;
    }
    if (!destAddr.trim()) {
      setError("Enter a destination address");
      return;
    }
    if (activeAccount.type === "walletconnect") {
      setError("Bridge requires a mnemonic account — WalletConnect not yet supported");
      return;
    }
    if (!pair) {
      setError("This token pair is not supported for bridging");
      return;
    }

    setExecuting(true);
    setError(null);
    setTxId(null);

    const keepAlive = setInterval(() => void sendBg({ type: "KEEP_ALIVE" }), 30_000);
    try {
      const result = await sendBg<{ txId: string }>({
        type:               "BRIDGE_EXECUTE",
        sourceChain:        activeChain,
        sourceToken:        token.id,
        amount:             amount.trim(),
        decimals:           token.decimals,
        destinationAddress: destAddr.trim(),
        senderAddress:      activeAccount.address,
      });
      setTxId(result.txId);
      setAmount("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bridge failed. Please try again.");
    } finally {
      clearInterval(keepAlive);
      setExecuting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">

      {/* Route header */}
      <div className="flex items-center justify-between text-xs px-1 pb-1">
        <span className="font-semibold text-white">{CHAIN_LABEL[activeChain]}</span>
        <span className="text-algo">→</span>
        <span className="font-semibold text-white">{CHAIN_LABEL[destChain]}</span>
        <span className="text-gray-500 ml-auto">via Aramid</span>
      </div>

      {/* Token + Amount */}
      <div className="bg-surface-2 rounded-xl p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-gray-400">Amount</span>
          <span className="text-xs text-gray-500">Bal: {availableDisplay}</span>
        </div>
        <div className="flex gap-2">
          <select
            className="bg-surface-1 text-xs rounded-lg px-2 py-1.5 outline-none cursor-pointer text-white"
            value={tokenIdx}
            onChange={(e) => { setTokenIdx(Number(e.target.value)); reset(); }}
          >
            {tokens.map((t, i) => (
              <option key={t.id} value={i}>{t.symbol}</option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setTxId(null); setError(null); }}
            className="flex-1 bg-surface-1 text-white text-sm rounded-lg px-3 py-1.5 outline-none [appearance:textfield]"
          />
          <button
            onClick={() => { setAmount(availableDisplay); setTxId(null); setError(null); }}
            className="text-xs text-algo hover:underline px-1"
          >
            Max
          </button>
        </div>
      </div>

      {/* Destination address */}
      <div className="bg-surface-2 rounded-xl p-2.5">
        <span className="text-xs text-gray-400 block mb-1.5">Destination ({CHAIN_LABEL[destChain]})</span>
        <input
          type="text"
          placeholder="Paste destination address…"
          value={destAddr}
          onChange={(e) => { setDestAddr(e.target.value); setTxId(null); setError(null); }}
          className="w-full bg-surface-1 text-white text-xs rounded-lg px-3 py-1.5 outline-none font-mono"
          spellCheck={false}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-1.5">
          {error}
        </div>
      )}

      {/* Execute */}
      <button
        onClick={handleBridge}
        disabled={executing || !amount || !destAddr}
        className="w-full gradient-btn text-[#0D1117] text-sm font-bold py-2.5 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {executing ? "Bridging…" : `Bridge ${token.symbol} → ${pair?.destSymbol ?? "?"}`}
      </button>

      {/* Fee summary + success below button */}
      {amount && !isNaN(parseFloat(amount)) && parseFloat(amount) > 0 && pair && !txId && (
        <div className="flex justify-between text-xs text-gray-500 px-1">
          <span>Fee 0.1% · You receive</span>
          <span className="text-algo">{receiveDisplay}</span>
        </div>
      )}

      {txId && (
        <div className="text-xs text-green-400 bg-green-400/10 rounded-lg px-3 py-1.5 break-all">
          Bridged! TX: {txId}
        </div>
      )}
    </div>
  );
}
