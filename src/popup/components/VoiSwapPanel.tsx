import { useState, useEffect } from "react";
import { sendBg } from "../App";
import type { Account } from "@shared/types/wallet";
import type { AccountAsset } from "@shared/types/chain";

// Snowball token as returned by /config/tokens
interface SnowballToken {
  id: string;      // "0" for native VOI, numeric string for ARC-200
  symbol: string;
  name: string;
  decimals: number;
  imageUrl?: string;
}

interface TokenOption {
  id: number;      // 0 = native VOI
  symbol: string;
  name: string;
  decimals: number;
}

interface QuoteResult {
  quoteAmount: string;
  priceImpact: number | null;
  poolId: number | null;
  isMultiHop: boolean;
  outputAmountAtomic: string;
}

export default function VoiSwapPanel({
  activeAccount,
  balance,
  assets,
}: {
  activeAccount: Account;
  balance: bigint;
  assets: AccountAsset[];
}) {
  return <VoiSwapForm activeAccount={activeAccount} balance={balance} assets={assets} />;
}

function VoiSwapForm({
  activeAccount,
  balance,
  assets,
}: {
  activeAccount: Account;
  balance: bigint;
  assets: AccountAsset[];
}) {
  const [tokens, setTokens] = useState<TokenOption[]>([
    { id: 0, symbol: "VOI", name: "Voi", decimals: 6 },
  ]);
  const [tokensLoading, setTokensLoading] = useState(true);

  // Load Snowball token list on mount
  useEffect(() => {
    let cancelled = false;
    fetch("https://api.snowballswap.com/config/tokens")
      .then((r) => r.json())
      .then((data: { tokens: SnowballToken[] }) => {
        if (cancelled) return;
        const opts: TokenOption[] = data.tokens
          .filter((t) =>
            Number.isInteger(Number(t.id)) &&
            Number(t.id) >= 0 &&
            typeof t.symbol === "string" &&
            typeof t.decimals === "number"
          )
          .map((t) => ({
            id: Number(t.id),
            // Sanitise display strings — strip non-printable chars, cap length
            symbol: String(t.symbol).replace(/[^\x20-\x7E]/g, "").slice(0, 16),
            name: String(t.name ?? t.symbol).replace(/[^\x20-\x7E]/g, "").slice(0, 32),
            decimals: Math.max(0, Math.min(18, Number(t.decimals))),
          }));
        // VOI (id=0) should always be first
        opts.sort((a, b) => a.id - b.id);
        setTokens(opts);
      })
      .catch(() => {
        // Keep the default VOI entry on error
      })
      .finally(() => {
        if (!cancelled) setTokensLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const [fromId, setFromId] = useState<number>(0);
  const [toId,   setToId]   = useState<number>(302190); // default: VOI → aUSDC

  const fromToken = tokens.find((t) => t.id === fromId) ?? tokens[0];
  const toToken   = tokens.find((t) => t.id === toId)   ?? tokens[1];

  const [amount,    setAmount]    = useState("");
  const [slippage,  setSlippage]  = useState("1");
  const [quote,     setQuote]     = useState<QuoteResult | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [txId,      setTxId]      = useState<string | null>(null);

  function resetQuote() {
    setQuote(null);
    setTxId(null);
    setError(null);
  }

  function swapDirection() {
    setFromId(toId);
    setToId(fromId);
    resetQuote();
  }

  // Available balance for the "From" asset
  const availableAtomic =
    fromId === 0
      ? balance
      : (assets.find((a) => a.assetId === fromId)?.amount ?? 0n);
  const availableDisplay = formatAtomic(availableAtomic, fromToken.decimals);

  // ── Get Quote ──────────────────────────────────────────────────────────────
  async function handleGetQuote() {
    const trimAmt = amount.trim();
    if (!trimAmt || isNaN(parseFloat(trimAmt)) || parseFloat(trimAmt) <= 0) {
      setError("Enter a valid amount");
      return;
    }
    if (fromId === toId) {
      setError("From and To tokens must be different");
      return;
    }
    setLoading(true);
    setError(null);
    setQuote(null);
    setTxId(null);

    try {
      const result = await sendBg<QuoteResult>({
        type:       "VOI_SWAP_QUOTE",
        tokenIn:    fromToken.id,
        tokenOut:   toToken.id,
        amountIn:   trimAmt,
        decimalsIn: fromToken.decimals,
        decimalsOut: toToken.decimals,
        address:    activeAccount.address,
      });
      setQuote(result);
      if (result.isMultiHop) {
        setError(
          "This pair requires a multi-hop route — direct swaps only for now. " +
          "Try swapping to VOI or wVOI first."
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get quote");
    } finally {
      setLoading(false);
    }
  }

  // ── Execute Swap ───────────────────────────────────────────────────────────
  async function handleExecute() {
    if (!quote || !quote.poolId) return;
    const trimAmt = amount.trim();
    const slippageNum = parseFloat(slippage);
    if (isNaN(slippageNum) || slippageNum < 0 || slippageNum > 50) {
      setError("Slippage must be between 0 and 50");
      return;
    }
    if (activeAccount.type === "walletconnect") {
      setError("WalletConnect accounts are not yet supported for Voi swaps.");
      return;
    }

    setExecuting(true);
    setError(null);
    setTxId(null);

    const keepAlive = setInterval(() => void sendBg({ type: "KEEP_ALIVE" }), 30_000);
    try {
      const result = await sendBg<{ txId: string }>({
        type:       "VOI_SWAP_EXECUTE",
        poolId:     quote.poolId,
        tokenIn:    fromToken.id,
        tokenOut:   toToken.id,
        amountIn:   trimAmt,
        decimalsIn: fromToken.decimals,
        slippage:   slippageNum,
        address:    activeAccount.address,
      });
      setTxId(result.txId);
      setQuote(null);
      setAmount("");
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const isSlippage =
        raw.includes("assert failed") ||
        raw.includes("logic eval error") ||
        (raw.includes("assert") && raw.includes("pc="));
      // Surface user-safe messages; mask internal details for unknown errors
      const isSafeMsg =
        raw.includes("insufficient balance") ||
        raw.includes("address mismatch") ||
        raw.includes("locked") ||
        raw.includes("WalletConnect") ||
        raw.includes("slippage") ||
        raw.includes("simulation failed");
      setError(
        isSlippage
          ? "Swap rejected — pool price moved past slippage tolerance. Try again or increase slippage."
          : isSafeMsg
          ? raw
          : "Swap failed. Please try again."
      );
    } finally {
      clearInterval(keepAlive);
      setExecuting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">

      {/* From */}
      <div className="bg-surface-2 rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">From</span>
          <span className="text-xs text-gray-500">Balance: {availableDisplay}</span>
        </div>
        <div className="flex gap-2">
          <select
            className="bg-surface-1 text-xs rounded-lg px-2 py-1.5 outline-none cursor-pointer"
            value={fromId}
            onChange={(e) => { setFromId(Number(e.target.value)); resetQuote(); }}
            disabled={tokensLoading}
          >
            {tokens.filter((t) => t.id !== toId).map((t) => (
              <option key={t.id} value={t.id}>{t.symbol}</option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); resetQuote(); }}
            className="flex-1 bg-transparent text-right text-sm font-medium outline-none placeholder-gray-600"
          />
        </div>
      </div>

      {/* Swap direction */}
      <div className="flex justify-center -my-1">
        <button
          onClick={swapDirection}
          className="w-7 h-7 rounded-full bg-surface-2 hover:bg-surface-1 flex items-center justify-center text-gray-400 hover:text-white transition-colors text-sm"
          title="Swap direction"
        >
          ⇅
        </button>
      </div>

      {/* To */}
      <div className="bg-surface-2 rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-gray-400">To</span>
          {quote && !quote.isMultiHop && (
            <span className="text-xs text-voi font-medium">
              ≈ {quote.quoteAmount} {toToken.symbol}
            </span>
          )}
        </div>
        <select
          className="w-full bg-surface-1 text-xs rounded-lg px-2 py-1.5 outline-none cursor-pointer"
          value={toId}
          onChange={(e) => { setToId(Number(e.target.value)); resetQuote(); }}
          disabled={tokensLoading}
        >
          {tokens.filter((t) => t.id !== fromId).map((t) => (
            <option key={t.id} value={t.id}>{t.symbol}</option>
          ))}
        </select>
      </div>

      {/* Quote details */}
      {quote && !quote.isMultiHop && (
        <div className="bg-surface-2 rounded-xl p-3 text-xs flex flex-col gap-1.5">
          <div className="flex justify-between">
            <span className="text-gray-400">You receive</span>
            <span className="font-medium">{quote.quoteAmount} {toToken.symbol}</span>
          </div>
          {quote.priceImpact != null && (
            <div className="flex justify-between">
              <span className="text-gray-400">Price impact</span>
              <span className={quote.priceImpact > 2 ? "text-red-400" : "text-gray-300"}>
                {(quote.priceImpact * 100).toFixed(3)}%
              </span>
            </div>
          )}
        </div>
      )}

      {/* Slippage */}
      <div className="flex items-center justify-between px-1">
        <span className="text-xs text-gray-500">Slippage tolerance</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min="0"
            max="50"
            step="0.1"
            value={slippage}
            onChange={(e) => setSlippage(e.target.value)}
            className="w-14 bg-surface-2 text-xs rounded px-2 py-1 outline-none text-right"
          />
          <span className="text-xs text-gray-500">%</span>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Success */}
      {txId && (
        <div className="text-xs text-green-400 bg-green-400/10 border border-green-400/20 rounded-lg px-3 py-2">
          Swap confirmed!{" "}
          <a
            href={`https://explorer.voi.network/explorer/transaction/${txId}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View on Voi Observer
          </a>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleGetQuote}
          disabled={loading || executing || tokensLoading}
          className="flex-1 py-2.5 rounded-xl bg-surface-2 hover:bg-surface-1 text-xs font-medium transition-colors disabled:opacity-50"
        >
          {loading ? "Getting quote…" : "Get Quote"}
        </button>
        <button
          onClick={handleExecute}
          disabled={!quote || quote.isMultiHop || !quote.poolId || executing || loading}
          className="flex-1 py-2.5 rounded-xl bg-voi text-black text-xs font-semibold hover:bg-voi/90 transition-colors disabled:opacity-40"
        >
          {executing ? "Swapping…" : "Swap"}
        </button>
      </div>

      <p className="text-[10px] text-gray-600 text-center">
        Powered by <span className="text-gray-500">Snowball + HumbleSwap</span>
      </p>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatAtomic(atomic: bigint, decimals: number): string {
  if (decimals === 0) return atomic.toString();
  const divisor = BigInt(10 ** decimals);
  const int  = atomic / divisor;
  const frac = atomic % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${int}.${fracStr}` : `${int}`;
}
