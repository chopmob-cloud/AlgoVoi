/**
 * VaultPanel — SpendingCapVault management UI.
 *
 * Security model (displayed to user):
 *   - Owner wallet  = your active account (mnemonic or WalletConnect)
 *   - Agent key     = auto-generated, stored encrypted in this extension
 *   - Contract      = enforces ALL limits on-chain — agent cannot exceed them
 *   - You can suspend the agent instantly if anything looks wrong
 */

import { useState, useEffect, useCallback } from "react";
import algosdk from "algosdk";
import { sendBg } from "../App";
import { base64ToBytes } from "@shared/utils/crypto";
import { CHAINS } from "@shared/constants";
import type { ChainId } from "@shared/types/chain";
import type { Account } from "@shared/types/wallet";
import { useWalletConnect } from "../hooks/useWalletConnect";

const D = 6; // decimals (both ALGO and VOI use 6)
const MICRO = 1_000_000n;

function microToDisplay(micro: string): string {
  const n = BigInt(micro);
  const whole = n / MICRO;
  const frac  = ((n % MICRO) * 100n) / MICRO;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, "0")}`;
}

function displayToMicro(val: string): string {
  const [w = "0", f = ""] = val.split(".");
  const fPadded = f.slice(0, D).padEnd(D, "0");
  return (BigInt(w) * MICRO + BigInt(fPadded)).toString();
}

function pct(spent: string, cap: string): number {
  const s = BigInt(spent);
  const c = BigInt(cap);
  if (c === 0n) return 0;
  return Math.min(100, Number((s * 100n) / c));
}

// ── State types from background ───────────────────────────────────────────────

interface GlobalState {
  globalMaxPerTxn:  string;
  globalDailyCap:   string;
  globalMaxAsa:     string;
  allowlistEnabled: boolean;
  totalPaid:        string;
  totalPaidAsa:     string;
  txCount:          string;
  vaultBalance:     string;
}

interface AgentState {
  enabled:   boolean;
  maxPerTxn: string;
  dailyCap:  string;
  dayBucket: string;
  daySpent:  string;
}

interface VaultState {
  deployed:      boolean;
  appId?:        number;
  appAddress?:   string;
  agentAddress?: string;
  global?:       GlobalState;
  agent?:        AgentState | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

// ── Component ─────────────────────────────────────────────────────────────────

export default function VaultPanel({
  chain,
  activeAccount,
}: {
  chain:         ChainId;
  activeAccount: Account | undefined;
}) {
  const [state,     setState]     = useState<VaultState | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [busy,      setBusy]      = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const [txId,      setTxId]      = useState<string | null>(null);
  const [wcStatus,  setWcStatus]  = useState<string | null>(null);

  const wc  = useWalletConnect();
  const cfg = CHAINS[chain];

  const loadState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await sendBg<VaultState>({ type: "VAULT_GET_STATE", chain });
      setState(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load vault state");
    } finally {
      setLoading(false);
    }
  }, [chain]);

  useEffect(() => { loadState(); }, [loadState]);

  // ── Core action dispatcher ─────────────────────────────────────────────────
  // Handles both mnemonic (direct) and WalletConnect (multi-step) paths.

  async function doAction(action: string, extra?: Record<string, string | boolean | number>) {
    setBusy(true);
    setError(null);
    setTxId(null);
    setWcStatus(null);
    try {
      const result = await sendBg<AnyObj>({ type: action, chain, ...extra });

      if (result.needsWcSign) {
        if (result.step === "remap") {
          // ── WC vault remap — single group sign (fund box + add_agent) ────

          setWcStatus("Approve vault reconnect in your wallet app…");
          const remapTxns = (result.setupGroupB64s as string[]).map((b64) =>
            algosdk.decodeUnsignedTransaction(base64ToBytes(b64))
          );
          const signedRemap = await wc.signGroup(
            result.sessionTopic as string, chain, remapTxns, result.signerAddress as string
          );
          const signedRemapB64s = signedRemap.map((b) => btoa(String.fromCharCode(...b)));

          setWcStatus("Confirming on-chain…");
          const remapResult = await sendBg<AnyObj>({
            type:            "VAULT_WC_REMAP_SUBMIT",
            signedGroupB64s: signedRemapB64s,
            chain,
            appId:           result.appId    as number,
            appAddress:      result.appAddress as string,
          });
          if (remapResult.txId) setTxId(remapResult.txId as string);

        } else if (result.step === "create") {
          // ── WC vault deploy — 2 signing rounds ──────────────────────────

          // Round 1: sign the create application txn
          setWcStatus("Approve vault creation in your wallet app…");
          const createTxn = algosdk.decodeUnsignedTransaction(
            base64ToBytes(result.unsignedTxnB64 as string)
          );
          const signedCreate = await wc.signTransaction(
            result.sessionTopic as string, chain, createTxn, result.signerAddress as string
          );
          const signedCreateB64 = btoa(String.fromCharCode(...signedCreate));

          // Submit create, get appId + setup group
          setWcStatus("Waiting for on-chain confirmation…");
          const step2 = await sendBg<AnyObj>({
            type:           "VAULT_WC_SUBMIT_CREATE",
            signedTxnB64:   signedCreateB64,
            chain,
            agentAddress:   result.agentAddress   as string,
            agentMaxPerTxn: result.agentMaxPerTxn as string,
            agentDailyCap:  result.agentDailyCap  as string,
          });

          // Round 2: sign the fund + add_agent atomic group
          setWcStatus("Approve vault funding in your wallet app…");
          const setupTxns = (step2.setupGroupB64s as string[]).map((b64) =>
            algosdk.decodeUnsignedTransaction(base64ToBytes(b64))
          );
          const signedGroup = await wc.signGroup(
            step2.sessionTopic as string, chain, setupTxns, step2.signerAddress as string
          );
          const signedGroupB64s = signedGroup.map((b) => btoa(String.fromCharCode(...b)));

          // Finalise vault
          setWcStatus("Finalising vault on-chain…");
          const step3 = await sendBg<AnyObj>({
            type:            "VAULT_WC_SUBMIT_SETUP",
            signedGroupB64s,
            chain,
            appId:           step2.appId    as number,
            appAddress:      step2.appAddress as string,
          });
          if (step3.txId) setTxId(step3.txId as string);

        } else {
          // ── WC single-txn owner action (suspend/resume/update/withdraw) ─

          setWcStatus("Approve in your wallet app…");
          const actionTxn = algosdk.decodeUnsignedTransaction(
            base64ToBytes(result.unsignedTxnB64 as string)
          );
          const signedAction = await wc.signTransaction(
            result.sessionTopic as string, chain, actionTxn, result.signerAddress as string
          );
          const signedActionB64 = btoa(String.fromCharCode(...signedAction));

          setWcStatus("Confirming on-chain…");
          const submitResult = await sendBg<AnyObj>({
            type:          "VAULT_WC_ACTION_SUBMIT",
            signedTxnB64:  signedActionB64,
            chain,
          });
          if (submitResult.txId) setTxId(submitResult.txId as string);
        }

      } else {
        // Mnemonic path — result contains txId directly
        if (result.txId) setTxId(result.txId as string);
      }

      await loadState();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setWcStatus(null);
    }
  }

  // ── No account ────────────────────────────────────────────────────────────

  if (!activeAccount) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-xs text-gray-400">No active account</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-5 h-5 border-2 border-algo border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── WC status overlay ─────────────────────────────────────────────────────

  if (wcStatus) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4 text-center px-4">
        <div className="w-8 h-8 border-2 border-algo border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-gray-300">{wcStatus}</p>
        <p className="text-[10px] text-gray-500">
          Check your WalletConnect wallet app to approve the request.
        </p>
      </div>
    );
  }

  // ── Deploy wizard ─────────────────────────────────────────────────────────

  if (!state?.deployed) {
    return <DeployWizard chain={chain} ticker={cfg.ticker} onDeploy={doAction} busy={busy} error={error} />;
  }

  // ── Vault dashboard ───────────────────────────────────────────────────────

  const { appId, appAddress, agentAddress, global: g, agent: a } = state;
  const explorerBase = cfg.explorer;
  const agentEnabled = a?.enabled ?? false;

  // Effective day cap (0 = use global)
  const agentCap = a?.dailyCap !== "0" ? a!.dailyCap : g!.globalDailyCap;
  const spentPct  = pct(a?.daySpent ?? "0", agentCap);

  return (
    <div className="flex flex-col gap-3">
      {/* Vault info bar */}
      <div className="bg-surface-2 rounded-xl p-3 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Vault App ID</span>
          <a
            href={`${explorerBase}/application/${appId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-algo hover:underline font-mono"
          >
            {appId} ↗
          </a>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Vault Balance</span>
          <span className="text-xs font-semibold">
            {microToDisplay(g?.vaultBalance ?? "0")} {cfg.ticker}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-400">Total paid</span>
          <span className="text-xs text-gray-300">
            {microToDisplay(g?.totalPaid ?? "0")} {cfg.ticker}
            {" · "}{g?.txCount ?? "0"} txns
          </span>
        </div>
      </div>

      {/* Agent status */}
      <div className={`rounded-xl p-3 flex flex-col gap-2 ${agentEnabled ? "bg-green-900/20 border border-green-700/30" : "bg-red-900/20 border border-red-700/30"}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${agentEnabled ? "bg-green-400" : "bg-red-400"}`} />
            <span className="text-xs font-medium">Agent</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${agentEnabled ? "bg-green-500/20 text-green-300" : "bg-red-500/20 text-red-300"}`}>
              {agentEnabled ? "ACTIVE" : "SUSPENDED"}
            </span>
          </div>
          <button
            onClick={() => doAction("VAULT_ACTION", { action: agentEnabled ? "suspend" : "resume" })}
            disabled={busy}
            className={`text-xs px-2 py-1 rounded-lg font-medium transition-colors ${
              agentEnabled
                ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                : "bg-green-500/20 text-green-300 hover:bg-green-500/30"
            } disabled:opacity-40`}
          >
            {agentEnabled ? "Suspend" : "Resume"}
          </button>
        </div>

        <div className="text-[10px] font-mono text-gray-500 truncate" title={agentAddress}>
          {agentAddress?.slice(0, 20)}…{agentAddress?.slice(-6)}
        </div>

        {/* Day spent progress bar */}
        <div>
          <div className="flex justify-between text-[10px] text-gray-400 mb-1">
            <span>Today</span>
            <span>
              {microToDisplay(a?.daySpent ?? "0")} / {microToDisplay(agentCap)} {cfg.ticker}
            </span>
          </div>
          <div className="w-full h-1.5 bg-surface-1 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${spentPct > 80 ? "bg-orange-400" : "bg-algo"}`}
              style={{ width: `${spentPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Global limits */}
      <UpdateLimitsCard chain={chain} ticker={cfg.ticker} global={g!} onUpdate={doAction} busy={busy} />

      {/* Withdraw */}
      <WithdrawCard chain={chain} ticker={cfg.ticker} ownerAddr={activeAccount.address} onWithdraw={doAction} busy={busy} />

      {/* Fund vault */}
      <div className="bg-surface-2 rounded-xl p-3">
        <p className="text-xs text-gray-400 mb-1 font-medium">Fund vault</p>
        <p className="text-[10px] text-gray-500 mb-2">
          Send {cfg.ticker} directly to the vault address to top it up.
        </p>
        <button
          onClick={() => {
            if (appAddress) navigator.clipboard.writeText(appAddress);
          }}
          className="text-[10px] font-mono text-algo hover:text-algo/80 break-all text-left"
          title="Click to copy"
        >
          {appAddress} ⎘
        </button>
      </div>

      {/* Status messages */}
      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-700/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      {txId && (
        <div className="text-xs text-green-400 bg-green-900/20 border border-green-700/30 rounded-lg px-3 py-2">
          ✓ tx: <a href={`${explorerBase}/tx/${txId}`} target="_blank" rel="noopener noreferrer" className="underline font-mono">{txId.slice(0, 20)}…</a>
        </div>
      )}
    </div>
  );
}

// ── Deploy Wizard ─────────────────────────────────────────────────────────────

function DeployWizard({
  chain,
  ticker,
  onDeploy,
  busy,
  error,
}: {
  chain:    ChainId;
  ticker:   string;
  onDeploy: (action: string, extra: Record<string, string | boolean | number>) => Promise<void>;
  busy:     boolean;
  error:    string | null;
}) {
  const [maxPerTxn,  setMaxPerTxn]  = useState("1");     // 1 ALGO/VOI
  const [dailyCap,   setDailyCap]   = useState("10");    // 10 ALGO/VOI
  const [maxAsa,     setMaxAsa]     = useState("1");     // 1 USDC/aUSDC
  const [allowlist,  setAllowlist]  = useState(false);
  const [showRemap,  setShowRemap]  = useState(false);
  const [remapAppId, setRemapAppId] = useState("");

  function handleDeploy() {
    onDeploy("VAULT_DEPLOY", {
      globalMaxPerTxn:  displayToMicro(maxPerTxn),
      globalDailyCap:   displayToMicro(dailyCap),
      globalMaxAsa:     displayToMicro(maxAsa),
      allowlistEnabled: allowlist,
      agentMaxPerTxn:   "0", // inherit global
      agentDailyCap:    "0", // inherit global
    });
  }

  function handleRemap() {
    const id = parseInt(remapAppId.trim(), 10);
    if (!id || isNaN(id)) return;
    onDeploy("VAULT_REMAP", {
      appId:          id,
      agentMaxPerTxn: "0", // inherit global
      agentDailyCap:  "0", // inherit global
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="bg-surface-2 rounded-xl p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">🏦</span>
          <div>
            <p className="text-sm font-semibold">Deploy Spending Vault</p>
            <p className="text-xs text-gray-400">On-chain limits, controlled by you</p>
          </div>
        </div>
        <div className="text-[10px] text-gray-500 leading-relaxed">
          Deploys a smart contract that holds funds and enforces limits on every payment.
          An agent key is auto-generated and stored encrypted in this extension.
          <strong className="text-gray-300"> The contract enforces all caps — even if the agent key is compromised.</strong>
        </div>
      </div>

      {/* Security callout */}
      <div className="grid grid-cols-3 gap-2">
        {[
          ["🔑", "You own it", "Owner key never leaves your wallet"],
          ["⚙️", "On-chain limits", "AVM enforces caps, not software"],
          ["⚡", "Instant freeze", "Suspend agent with one click"],
        ].map(([icon, title, desc]) => (
          <div key={title} className="bg-surface-2 rounded-lg p-2 text-center">
            <div className="text-base mb-1">{icon}</div>
            <div className="text-[10px] font-medium text-white mb-0.5">{title}</div>
            <div className="text-[10px] text-gray-500 leading-tight">{desc}</div>
          </div>
        ))}
      </div>

      {/* Limit inputs */}
      <div className="bg-surface-2 rounded-xl p-3 flex flex-col gap-3">
        <p className="text-xs font-medium text-gray-300">Global limits ({ticker})</p>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-400">Max per payment</span>
          <input
            type="number" min="0.001" step="0.1"
            value={maxPerTxn}
            onChange={(e) => setMaxPerTxn(e.target.value)}
            className="input text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-400">Max per day</span>
          <input
            type="number" min="0.001" step="1"
            value={dailyCap}
            onChange={(e) => setDailyCap(e.target.value)}
            className="input text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-400">Max per ASA payment (USDC/aUSDC)</span>
          <input
            type="number" min="0.001" step="0.1"
            value={maxAsa}
            onChange={(e) => setMaxAsa(e.target.value)}
            className="input text-sm"
          />
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={allowlist}
            onChange={(e) => setAllowlist(e.target.checked)}
            className="rounded"
          />
          <span className="text-[10px] text-gray-400">Restrict to approved recipients only</span>
        </label>
      </div>

      <div className="text-[10px] text-gray-500 bg-surface-2 rounded-lg px-3 py-2">
        ⚠ Requires ~0.4 {ticker} in your wallet for deployment fees and vault MBR (base + box storage).
        You can top up the vault separately after deployment.
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-700/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <button
        onClick={handleDeploy}
        disabled={busy || !maxPerTxn || !dailyCap}
        className="btn-primary w-full py-3 text-sm font-semibold disabled:opacity-40"
      >
        {busy ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
            Deploying…
          </span>
        ) : `Deploy Vault on ${CHAINS[chain].name}`}
      </button>

      {/* Remap existing vault */}
      <div className="bg-surface-2 rounded-xl overflow-hidden">
        <button
          onClick={() => setShowRemap((s) => !s)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-gray-400 hover:text-gray-300"
        >
          <span>Already have a vault? Reconnect it</span>
          <span>{showRemap ? "▲" : "▼"}</span>
        </button>
        {showRemap && (
          <div className="px-3 pb-3 flex flex-col gap-2 border-t border-surface-1">
            <p className="text-[10px] text-gray-500 pt-2 leading-relaxed">
              Enter your existing vault App ID. A new agent key will be generated
              and registered on-chain — the contract limits are unchanged.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-gray-400">App ID</span>
              <input
                type="number"
                min="1"
                step="1"
                value={remapAppId}
                onChange={(e) => setRemapAppId(e.target.value)}
                placeholder="e.g. 3487338609"
                className="input text-sm font-mono"
              />
            </label>
            <button
              onClick={handleRemap}
              disabled={busy || !remapAppId.trim()}
              className="btn-primary text-xs py-2 font-semibold disabled:opacity-40"
            >
              {busy ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />
                  Reconnecting…
                </span>
              ) : "Reconnect Vault"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Update Limits Card ────────────────────────────────────────────────────────

function UpdateLimitsCard({
  chain: _chain,
  ticker,
  global: g,
  onUpdate,
  busy,
}: {
  chain:    ChainId;
  ticker:   string;
  global:   GlobalState;
  onUpdate: (action: string, extra: Record<string, string | boolean>) => Promise<void>;
  busy:     boolean;
}) {
  const [open,      setOpen]      = useState(false);
  const [maxPerTxn, setMaxPerTxn] = useState(microToDisplay(g.globalMaxPerTxn));
  const [dailyCap,  setDailyCap]  = useState(microToDisplay(g.globalDailyCap));
  const [maxAsa,    setMaxAsa]    = useState(microToDisplay(g.globalMaxAsa));

  function handleUpdate() {
    onUpdate("VAULT_ACTION", {
      action:    "update_limits",
      maxPerTxn: displayToMicro(maxPerTxn),
      dailyCap:  displayToMicro(dailyCap),
      maxAsa:    displayToMicro(maxAsa),
    }).then(() => setOpen(false));
  }

  return (
    <div className="bg-surface-2 rounded-xl p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-xs font-medium"
      >
        <span>Global limits ({ticker})</span>
        <span className="text-gray-400">{open ? "▲" : "▼"}</span>
      </button>

      {!open && (
        <div className="flex gap-4 mt-2">
          {[
            ["Per txn", g.globalMaxPerTxn],
            ["Per day", g.globalDailyCap],
            ["ASA/txn", g.globalMaxAsa],
          ].map(([label, val]) => (
            <div key={label}>
              <div className="text-[10px] text-gray-400">{label}</div>
              <div className="text-xs font-semibold">{microToDisplay(val)} {ticker}</div>
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-2 mt-3">
          {[
            ["Max per txn", maxPerTxn, setMaxPerTxn],
            ["Max per day", dailyCap, setDailyCap],
            ["Max ASA/txn", maxAsa, setMaxAsa],
          ].map(([label, val, set]) => (
            <label key={label as string} className="flex flex-col gap-0.5">
              <span className="text-[10px] text-gray-400">{label as string}</span>
              <input
                type="number" min="0.001" step="0.1"
                value={val as string}
                onChange={(e) => (set as (v: string) => void)(e.target.value)}
                className="input text-xs py-1"
              />
            </label>
          ))}
          <button
            onClick={handleUpdate}
            disabled={busy}
            className="btn-primary text-xs py-1.5 mt-1 disabled:opacity-40"
          >
            {busy ? "Updating…" : "Update Limits"}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Withdraw Card ─────────────────────────────────────────────────────────────

function WithdrawCard({
  chain: _chain,
  ticker,
  ownerAddr,
  onWithdraw,
  busy,
}: {
  chain:      ChainId;
  ticker:     string;
  ownerAddr:  string;
  onWithdraw: (action: string, extra: Record<string, string | boolean>) => Promise<void>;
  busy:       boolean;
}) {
  const [open,     setOpen]     = useState(false);
  const [receiver, setReceiver] = useState(ownerAddr);
  const [amount,   setAmount]   = useState("1");

  function handleWithdraw() {
    onWithdraw("VAULT_ACTION", {
      action:   "withdraw",
      receiver,
      amount:   displayToMicro(amount),
    }).then(() => setOpen(false));
  }

  return (
    <div className="bg-surface-2 rounded-xl p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between text-xs font-medium"
      >
        <span>Withdraw from vault</span>
        <span className="text-gray-400">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 mt-3">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-gray-400">Recipient</span>
            <input
              type="text"
              value={receiver}
              onChange={(e) => setReceiver(e.target.value)}
              className="input text-xs py-1 font-mono"
              placeholder="Algorand address"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] text-gray-400">Amount ({ticker})</span>
            <input
              type="number" min="0.001" step="0.1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="input text-xs py-1"
            />
          </label>
          <button
            onClick={handleWithdraw}
            disabled={busy || !receiver || !amount}
            className="btn-primary text-xs py-1.5 mt-1 disabled:opacity-40"
          >
            {busy ? "Withdrawing…" : `Withdraw ${amount} ${ticker}`}
          </button>
        </div>
      )}
    </div>
  );
}
