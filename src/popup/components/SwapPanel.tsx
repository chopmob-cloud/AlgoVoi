import { useState, useMemo } from "react";
import { RouterClient } from "@txnlab/haystack-router";
import type { SwapQuote, SignerFunction } from "@txnlab/haystack-router";
import { sendBg } from "../App";
import { signGroupIndexedWithWC } from "@shared/utils/wc-sign-group";
import type { Account } from "@shared/types/wallet";
import type { AccountAsset } from "@shared/types/chain";

const HAYSTACK_API_KEY =
  (import.meta.env.VITE_HAYSTACK_ROUTER_API_KEY as string | undefined) ?? "";
const HAYSTACK_REFERRER =
  (import.meta.env.VITE_HAYSTACK_REFERRER_ADDRESS as string | undefined) ?? "";

// Popular Algorand ASAs — always shown in "To" dropdown even if not yet held
const POPULAR_ASSETS = [
  { assetId: 31566704, name: "USDC", decimals: 6 },
  { assetId: 312769,   name: "USDt", decimals: 6 },
];

interface AssetOption {
  assetId: number; // 0 = native ALGO
  label: string;
  decimals: number;
}

interface QuoteDisplay {
  quoteAmount: string;
  priceImpact: number | null;
  usdIn: number | null;
  usdOut: number | null;
  routeCount: number;
}

export default function SwapPanel({
  activeAccount,
  balance,
  assets,
}: {
  activeAccount: Account;
  balance: bigint;
  assets: AccountAsset[];
}) {
  return (
    <SwapForm activeAccount={activeAccount} balance={balance} assets={assets} />
  );
}

function SwapForm({
  activeAccount,
  balance,
  assets,
}: {
  activeAccount: Account;
  balance: bigint;
  assets: AccountAsset[];
}) {
  const isWC = activeAccount.type === "walletconnect";

  // Build asset option list: ALGO + held ASAs + popular assets not yet held
  const assetOptions: AssetOption[] = useMemo(() => {
    const opts: AssetOption[] = [{ assetId: 0, label: "ALGO", decimals: 6 }];
    for (const a of assets) {
      opts.push({
        assetId: a.assetId,
        label: a.unitName || a.name || `#${a.assetId}`,
        decimals: a.decimals,
      });
    }
    for (const p of POPULAR_ASSETS) {
      if (!opts.find((o) => o.assetId === p.assetId)) {
        opts.push({ assetId: p.assetId, label: p.name, decimals: p.decimals });
      }
    }
    return opts;
  }, [assets]);

  const [fromId, setFromId] = useState<number>(0);
  const [toId,   setToId]   = useState<number>(31566704); // default: ALGO → USDC

  const fromAsset = assetOptions.find((o) => o.assetId === fromId) ?? assetOptions[0];
  const toAsset   = assetOptions.find((o) => o.assetId === toId)   ?? assetOptions[1];

  const [amount,    setAmount]    = useState("");
  const [slippage,  setSlippage]  = useState("0.5");
  const [quote,     setQuote]     = useState<QuoteDisplay | null>(null);
  // WC path only: keep the raw SwapQuote so newSwap() can reuse it
  const [wcQuote,   setWcQuote]   = useState<SwapQuote | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [txIds,     setTxIds]     = useState<string[] | null>(null);

  function resetQuote() {
    setQuote(null);
    setWcQuote(null);
    setTxIds(null);
    setError(null);
  }

  function swapAssets() {
    setFromId(toId);
    setToId(fromId);
    resetQuote();
  }

  // ── Popup RouterClient for WC path (lazy, one per render cycle is fine) ──
  function makePopupClient() {
    return new RouterClient({
      apiKey: HAYSTACK_API_KEY,
      autoOptIn: true,
      feeBps: 15,
      // Pin to algonode — matches manifest CSP; avoids 4160.nodely.dev CSP violation
      algodUri:   "https://mainnet-api.algonode.cloud",
      algodToken: "",
      algodPort:  443,
      ...(HAYSTACK_REFERRER ? { referrerAddress: HAYSTACK_REFERRER } : {}),
    });
  }

  // ── Get Quote ──────────────────────────────────────────────────────────────
  async function handleGetQuote() {
    const trimAmt = amount.trim();
    if (!trimAmt || isNaN(parseFloat(trimAmt)) || parseFloat(trimAmt) <= 0) {
      setError("Enter a valid amount");
      return;
    }
    if (fromId === toId) {
      setError("From and To assets must be different");
      return;
    }
    setLoading(true);
    setError(null);
    setQuote(null);
    setWcQuote(null);
    setTxIds(null);

    try {
      if (isWC) {
        // WC path: run RouterClient directly in the popup
        const client      = makePopupClient();
        const amountAtomic = parseDecimal(trimAmt, fromAsset.decimals);
        const q = await client.newQuote({
          fromASAID: fromAsset.assetId,
          toASAID:   toAsset.assetId,
          amount:    amountAtomic,
          address:   activeAccount.address,
        });
        setWcQuote(q);
        setQuote({
          quoteAmount: formatAtomic(q.quote, toAsset.decimals),
          priceImpact: q.userPriceImpact ?? null,
          usdIn:       q.usdIn  ?? null,
          usdOut:      q.usdOut ?? null,
          routeCount:  q.route?.length ?? 0,
        });
      } else {
        // Mnemonic path: background handles everything
        const result = await sendBg<QuoteDisplay>({
          type:         "SWAP_QUOTE",
          fromAssetId:  fromAsset.assetId,
          fromDecimals: fromAsset.decimals,
          toAssetId:    toAsset.assetId,
          toDecimals:   toAsset.decimals,
          amount:       trimAmt,
          address:      activeAccount.address,
        });
        setQuote(result);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get quote");
    } finally {
      setLoading(false);
    }
  }

  // ── Execute Swap ───────────────────────────────────────────────────────────
  async function handleExecute() {
    if (!quote) return;
    const trimAmt    = amount.trim();
    const slippageNum = parseFloat(slippage);
    if (isNaN(slippageNum) || slippageNum < 0 || slippageNum > 50) {
      setError("Slippage must be between 0 and 50");
      return;
    }
    setExecuting(true);
    setError(null);
    setTxIds(null);

    try {
      if (isWC) {
        // ── WC path: sign in popup via WalletConnect ─────────────────────
        console.log("[swap-wc] execute start — wcQuote:", !!wcQuote, "sessionTopic:", activeAccount.wcSessionTopic?.slice(0, 16));
        if (!wcQuote) throw new Error("Quote expired — get a new quote first");
        const sessionTopic = activeAccount.wcSessionTopic;
        if (!sessionTopic) throw new Error("WalletConnect session not found");

        const signer: SignerFunction = async (txnGroup, indexesToSign) => {
          console.log("[swap-wc] signer called — txns:", txnGroup.length, "toSign:", indexesToSign);
          return signGroupIndexedWithWC(
            sessionTopic,
            "algorand",
            txnGroup,
            indexesToSign,
            activeAccount.address
          );
        };

        console.log("[swap-wc] calling newSwap...");
        const client = makePopupClient();
        const swap   = await client.newSwap({
          quote:    wcQuote,
          address:  activeAccount.address,
          signer,
          slippage: slippageNum,
        });
        console.log("[swap-wc] calling execute...");
        const result = await swap.execute();
        setTxIds(result.txIds);
        setQuote(null);
        setWcQuote(null);
        setAmount("");
      } else {
        // ── Mnemonic path: background signs + submits ────────────────────
        const result = await sendBg<{ txIds: string[]; confirmedRound: string; outputAmount: string }>({
          type:         "SWAP_EXECUTE",
          fromAssetId:  fromAsset.assetId,
          fromDecimals: fromAsset.decimals,
          toAssetId:    toAsset.assetId,
          toDecimals:   toAsset.decimals,
          amount:       trimAmt,
          slippage:     slippageNum,
          address:      activeAccount.address,
        });
        setTxIds(result.txIds);
        setQuote(null);
        setAmount("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Swap failed");
    } finally {
      setExecuting(false);
    }
  }

  // Available balance display for "From" asset
  const availableAtomic =
    fromId === 0
      ? balance
      : (assets.find((a) => a.assetId === fromId)?.amount ?? 0n);
  const availableDisplay = formatAtomic(availableAtomic, fromAsset.decimals);

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
          >
            {assetOptions.filter((o) => o.assetId !== toId).map((o) => (
              <option key={o.assetId} value={o.assetId}>{o.label}</option>
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

      {/* Swap direction button */}
      <div className="flex justify-center -my-1">
        <button
          onClick={swapAssets}
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
          {quote && (
            <span className="text-xs text-algo font-medium">
              ≈ {quote.quoteAmount} {toAsset.label}
            </span>
          )}
        </div>
        <select
          className="w-full bg-surface-1 text-xs rounded-lg px-2 py-1.5 outline-none cursor-pointer"
          value={toId}
          onChange={(e) => { setToId(Number(e.target.value)); resetQuote(); }}
        >
          {assetOptions.filter((o) => o.assetId !== fromId).map((o) => (
            <option key={o.assetId} value={o.assetId}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Quote details */}
      {quote && (
        <div className="bg-surface-2 rounded-xl p-3 text-xs flex flex-col gap-1.5">
          <div className="flex justify-between">
            <span className="text-gray-400">You receive</span>
            <span className="font-medium">{quote.quoteAmount} {toAsset.label}</span>
          </div>
          {quote.priceImpact != null && (
            <div className="flex justify-between">
              <span className="text-gray-400">Price impact</span>
              <span className={quote.priceImpact > 2 ? "text-red-400" : "text-gray-300"}>
                {quote.priceImpact.toFixed(2)}%
              </span>
            </div>
          )}
          {quote.usdOut != null && (
            <div className="flex justify-between">
              <span className="text-gray-400">USD value</span>
              <span className="text-gray-300">${quote.usdOut.toFixed(2)}</span>
            </div>
          )}
          {quote.routeCount > 0 && (
            <div className="flex justify-between">
              <span className="text-gray-400">Routes</span>
              <span className="text-gray-300">{quote.routeCount}</span>
            </div>
          )}
          {isWC && (
            <p className="text-[10px] text-gray-500 pt-1">
              Your wallet will prompt for approval on your phone.
            </p>
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
      {txIds && (
        <div className="text-xs text-green-400 bg-green-400/10 border border-green-400/20 rounded-lg px-3 py-2">
          Swap confirmed!{" "}
          <a
            href={`https://allo.info/tx/${txIds[0]}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View on Allo
          </a>
        </div>
      )}

      {/* WC waiting-for-phone banner */}
      {executing && isWC && (
        <div className="flex flex-col gap-1.5 bg-purple-500/10 border border-purple-500/20 rounded-lg px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 border-2 border-purple-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
            <p className="text-xs text-purple-300 font-medium">
              Open your wallet app to approve the swap.
            </p>
          </div>
          <p className="text-[10px] text-purple-400/70 leading-tight pl-5">
            Extension swaps won&apos;t send a push notification — open Pera / Defly / Lute manually and look for the pending signing request.
          </p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={handleGetQuote}
          disabled={loading || executing}
          className="flex-1 py-2.5 rounded-xl bg-surface-2 hover:bg-surface-1 text-xs font-medium transition-colors disabled:opacity-50"
        >
          {loading ? "Getting quote…" : "Get Quote"}
        </button>
        <button
          onClick={handleExecute}
          disabled={!quote || executing || loading}
          className="flex-1 py-2.5 rounded-xl bg-algo text-black text-xs font-semibold hover:bg-algo/90 transition-colors disabled:opacity-40"
        >
          {executing ? (isWC ? "Waiting…" : "Swapping…") : "Swap"}
        </button>
      </div>

      <p className="text-[10px] text-gray-600 text-center">
        Powered by <span className="text-gray-500">Haystack Router</span>
      </p>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDecimal(amount: string, decimals: number): bigint {
  const clean = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error(`Invalid amount: ${amount}`);
  const [intStr, fracStr = ""] = clean.split(".");
  const fracPadded = fracStr.slice(0, decimals).padEnd(decimals, "0");
  const atomic = BigInt(intStr) * BigInt(10 ** decimals) + BigInt(fracPadded);
  // FIND-B: match background uint64 overflow guard (swap-handler.ts SW-1)
  if (atomic > 18_446_744_073_709_551_615n) {
    throw new Error("Amount exceeds maximum representable value (uint64 overflow)");
  }
  return atomic;
}

function formatAtomic(atomic: bigint, decimals: number): string {
  if (decimals === 0) return atomic.toString();
  const divisor = BigInt(10 ** decimals);
  const int  = atomic / divisor;
  const frac = atomic % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${int}.${fracStr}` : `${int}`;
}


