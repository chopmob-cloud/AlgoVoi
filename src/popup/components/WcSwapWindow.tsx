/**
 * WcSwapWindow — runs inside a detached chrome.windows.create() popup.
 *
 * Why a separate window?
 *   The extension popup closes the moment the user clicks outside it. When
 *   that happens, the SignClient WebSocket is torn down and the pending
 *   client.request() is orphaned — Defly never gets an answer and the swap
 *   silently fails. A detached popup window (type: "popup") stays open even
 *   when the user switches apps to approve in Defly.
 *
 * Stale session recovery:
 *   If the ping check detects the session is dead, a "Re-pair" button is shown.
 *   Clicking it renders WalletConnectModal inline. After the user re-pairs,
 *   addWCAccount upserts the existing account's session topic (no duplicate
 *   created) and the swap auto-retries with the fresh session — no account
 *   removal required.
 */

import { useEffect, useRef, useState } from "react";
import { RouterClient } from "@txnlab/haystack-router";
import type { SignerFunction } from "@txnlab/haystack-router";
import { signGroupIndexedWithWC } from "@shared/utils/wc-sign-group";
import WalletConnectModal from "./WalletConnectModal";
import { sendBg } from "../App";
import type { Account } from "@shared/types/wallet";

const HAYSTACK_API_KEY =
  (import.meta.env.VITE_HAYSTACK_ROUTER_API_KEY as string | undefined) ?? "";
const HAYSTACK_REFERRER =
  (import.meta.env.VITE_HAYSTACK_REFERRER_ADDRESS as string | undefined) ?? "";

type Phase = "quoting" | "signing" | "done" | "error" | "stale" | "repairing";

export default function WcSwapWindow() {
  // Parse all swap params from the URL — set by SwapPanel before opening window
  const p            = new URLSearchParams(window.location.search);
  const fromId       = Number(p.get("fromId")       ?? "0");
  const toId         = Number(p.get("toId")         ?? "31566704");
  const fromDecimals = Number(p.get("fromDecimals") ?? "6");
  const toDecimals   = Number(p.get("toDecimals")   ?? "6");
  const fromLabel    = p.get("fromLabel") ?? "ALGO";
  const toLabel      = p.get("toLabel")   ?? "USDC";
  const amountStr    = p.get("amount")    ?? "";
  const slippageNum  = Number(p.get("slippage") ?? "0.5");
  const address      = p.get("address")  ?? "";

  // sessionTopic lives in a ref so the run() closure always reads the latest
  // value even after re-pairing updates it without re-mounting.
  const sessionTopicRef = useRef(p.get("sessionTopic") ?? "");

  const [phase,        setPhase]        = useState<Phase>("quoting");
  const [quoteDisplay, setQuoteDisplay] = useState<string | null>(null);
  const [txId,         setTxId]         = useState<string | null>(null);
  const [error,        setError]        = useState<string | null>(null);
  // Increment to re-trigger the swap effect (e.g. after re-pairing)
  const [runKey,       setRunKey]       = useState(0);

  // Keep-alive: reset auto-lock every 30 s while signing (can take minutes)
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  useEffect(() => {
    keepAliveRef.current = setInterval(
      () => void sendBg({ type: "KEEP_ALIVE" }),
      30_000
    );
    return () => clearInterval(keepAliveRef.current);
  }, []);

  // ── Main swap effect — re-runs on runKey change (initial + after re-pair) ──
  useEffect(() => {
    let cancelled = false;
    const topic = sessionTopicRef.current;
    if (!topic) return;

    async function run() {
      try {
        // ── 1. Fresh quote ──────────────────────────────────────────────────
        setPhase("quoting");
        setError(null);
        const client = new RouterClient({
          apiKey:    HAYSTACK_API_KEY,
          autoOptIn: true,
          feeBps:    15,
          algodUri:   "https://mainnet-api.algonode.cloud",
          algodToken: "",
          algodPort:  443,
          ...(HAYSTACK_REFERRER ? { referrerAddress: HAYSTACK_REFERRER } : {}),
        });

        const amountAtomic = parseDecimal(amountStr, fromDecimals);
        const quote = await client.newQuote({
          fromASAID: fromId,
          toASAID:   toId,
          amount:    amountAtomic,
          address,
        });
        if (cancelled) return;
        setQuoteDisplay(formatAtomic(quote.quote, toDecimals));
        setPhase("signing");

        // ── 2. Sign via WalletConnect (includes ping check) ─────────────────
        const signer: SignerFunction = async (txnGroup, indexesToSign) => {
          return signGroupIndexedWithWC(
            sessionTopicRef.current,
            "algorand",
            txnGroup,
            indexesToSign,
            address
          );
        };

        const swap = await client.newSwap({
          quote,
          address,
          signer,
          slippage: slippageNum,
        });

        // ── 3. Submit ────────────────────────────────────────────────────────
        const result = await swap.execute();
        if (cancelled) return;
        clearInterval(keepAliveRef.current);
        setTxId(result.txIds[0] ?? null);
        setPhase("done");

      } catch (err) {
        if (cancelled) return;
        clearInterval(keepAliveRef.current);
        const raw = err instanceof Error ? err.message : String(err);

        // Stale session — show re-pair UI instead of a dead-end error
        if (raw.includes("no longer active") || raw.includes("disconnected")) {
          setPhase("stale");
          return;
        }

        // Slippage assertion failure
        const isSlippage =
          raw.includes("assert failed") ||
          raw.includes("logic eval error") ||
          (raw.includes("assert") && raw.includes("pc="));
        setError(
          isSlippage
            ? "Pool price moved past your slippage tolerance while waiting for approval.\n" +
              "Close this window, increase slippage, and try again."
            : raw
        );
        setPhase("error");
      }
    }

    run();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);

  // Called by WalletConnectModal after successful re-pair.
  // addWCAccount (background) upserts — updates the existing account's session
  // topic rather than creating a duplicate. Then we retry the swap.
  function handleRepaired(account: Account) {
    if (!account.wcSessionTopic) return;
    sessionTopicRef.current = account.wcSessionTopic;
    setPhase("quoting");
    setRunKey((k) => k + 1); // triggers the swap effect to re-run
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-5 gap-5">
      {/* Header */}
      <div className="flex flex-col items-center gap-2">
        <div className="w-12 h-12 bg-algo rounded-xl flex items-center justify-center text-black font-bold text-xl">
          AV
        </div>
        <h1 className="text-lg font-bold text-white">AlgoVoi Swap</h1>
        <p className="text-xs text-gray-400 font-mono">
          {fromLabel} → {toLabel}
        </p>
      </div>

      {/* Re-pair modal — replaces everything else when session is dead */}
      {phase === "repairing" && (
        <div className="w-full max-w-xs">
          <WalletConnectModal
            chain="algorand"
            onConnected={handleRepaired}
            onClose={() => setPhase("stale")}
          />
        </div>
      )}

      {/* Status card — hidden while repairing */}
      {phase !== "repairing" && (
        <div className="w-full max-w-xs bg-surface-1 border border-surface-2 rounded-2xl p-5 flex flex-col gap-4">

          {/* Amount summary */}
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">You swap</span>
            <span className="font-semibold">{amountStr} {fromLabel}</span>
          </div>
          {quoteDisplay && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-400">You receive ≈</span>
              <span className="font-semibold text-algo">{quoteDisplay} {toLabel}</span>
            </div>
          )}

          {/* Phase indicator */}
          <div className="border-t border-surface-2 pt-4">

            {phase === "quoting" && (
              <div className="flex items-center gap-3">
                <div className="w-4 h-4 border-2 border-algo border-t-transparent rounded-full animate-spin flex-shrink-0" />
                <p className="text-sm text-gray-300">Fetching best route…</p>
              </div>
            )}

            {phase === "signing" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  <p className="text-sm text-purple-300 font-medium">
                    Waiting for approval in Defly / Pera
                  </p>
                </div>
                <div className="bg-purple-500/10 border border-purple-500/20 rounded-xl p-3 flex flex-col gap-1.5">
                  <p className="text-xs text-purple-200 font-semibold">
                    ✓ Keep this window open
                  </p>
                  <p className="text-[11px] text-purple-400/80 leading-relaxed">
                    Open your wallet app on your phone. Extension swaps don&apos;t
                    send push notifications — look for the pending signing request
                    in Defly / Pera / Lute.
                  </p>
                </div>
              </div>
            )}

            {phase === "done" && txId && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-green-400 text-lg">✓</span>
                  <p className="text-sm text-green-400 font-semibold">Swap confirmed!</p>
                </div>
                <a
                  href={`https://allo.info/tx/${txId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-algo underline text-center"
                >
                  View on Allo ↗
                </a>
                <button
                  onClick={() => window.close()}
                  className="btn-primary w-full mt-1"
                >
                  Close
                </button>
              </div>
            )}

            {/* Session stale — offer inline re-pair, no account removal needed */}
            {phase === "stale" && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-yellow-400 text-base">⚠</span>
                  <p className="text-sm text-yellow-300 font-semibold">
                    Wallet disconnected
                  </p>
                </div>
                <p className="text-xs text-gray-400 leading-relaxed">
                  The WalletConnect session with your wallet has expired or been
                  closed. Re-pair to continue — your account won&apos;t be removed.
                </p>
                <button
                  onClick={() => setPhase("repairing")}
                  className="btn-primary w-full"
                >
                  Re-pair wallet
                </button>
                <button
                  onClick={() => window.close()}
                  className="w-full py-2 rounded-xl bg-surface-2 border border-surface-2 text-xs font-semibold text-gray-400"
                >
                  Cancel
                </button>
              </div>
            )}

            {phase === "error" && (
              <div className="flex flex-col gap-3">
                <p className="text-xs text-red-400 leading-relaxed whitespace-pre-wrap">{error}</p>
                <button
                  onClick={() => window.close()}
                  className="w-full py-2 rounded-xl bg-surface-2 border border-surface-2 text-xs font-semibold text-gray-400"
                >
                  Close
                </button>
              </div>
            )}

          </div>
        </div>
      )}

      {phase !== "repairing" && (
        <p className="text-[10px] text-gray-600 text-center">
          Slippage: {slippageNum}% · Powered by Haystack Router
        </p>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parseDecimal(amount: string, decimals: number): bigint {
  const clean = amount.trim();
  const [intStr, fracStr = ""] = clean.split(".");
  const fracPadded = fracStr.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(intStr) * BigInt(10 ** decimals) + BigInt(fracPadded);
}

function formatAtomic(atomic: bigint, decimals: number): string {
  if (decimals === 0) return atomic.toString();
  const divisor = BigInt(10 ** decimals);
  const int  = atomic / divisor;
  const frac = atomic % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${int}.${fracStr}` : `${int}`;
}
