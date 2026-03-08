/**
 * WalletConnectModal
 *
 * Four-step flow:
 *  Step 1 — QR code displayed; user scans with Pera / Defly / Lute
 *  Step 2 — Waiting for wallet approval (spinner)
 *  Step 3 — Session established; user picks address + names the account
 *  Step 4 — Success: account saved; user clicks "Done" to close the tab
 *
 * Supports both Algorand (Pera, Defly, Lute) and Voi (Lute) chains.
 */

import { useState, useEffect } from "react";
import { useWalletConnect } from "../hooks/useWalletConnect";
import { STORAGE_KEY_META, WC_PAIR_TAB_KEY } from "@shared/constants";
import { appendDebugLog, exportDebugLog, sanitizeAddress, sanitizeTopic } from "@shared/debug-log";
import type { Account, WalletMeta } from "@shared/types/wallet";
import type { ChainId } from "@shared/types/chain";

interface Props {
  chain?: ChainId;           // defaults to "algorand"
  onConnected: (account: Account) => void;
  onClose: () => void;
}

const WALLET_LABELS: Record<string, string> = {
  algorand: "Pera · Defly · Lute · any ARC-0025 wallet",
  voi:      "Lute · any ARC-0025 Voi wallet",
};

// Auto-export is only active in Vite dev mode (import.meta.env.DEV = false in
// production builds).  appendDebugLog() writes to chrome.storage in all builds
// so the log is always readable via DevTools; the browser download is only
// triggered during local development to avoid unwanted downloads for users.
const DEBUG_EXPORT = import.meta.env.DEV;

export default function WalletConnectModal({ chain = "algorand", onConnected, onClose }: Props) {
  const { qrDataUrl, wcUri, session, error, startPairing, reset } =
    useWalletConnect();

  // User-selected chain — may differ from the prop if they switch mid-flow.
  // This is the authoritative chain stored on the account (wcChain).
  const [activeChain, setActiveChain] = useState<ChainId>(chain);

  const [accountName, setAccountName] = useState("");
  const [selectedAddress, setSelectedAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAccount, setSavedAccount] = useState<Account | null>(null);

  // Start pairing automatically when the tab opens
  useEffect(() => {
    startPairing(activeChain);
    return () => reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Switch to a different chain: reset WC state and re-initiate pairing. */
  function handleSwitchChain(newChain: ChainId) {
    if (newChain === activeChain) return;
    reset();
    setActiveChain(newChain);
    // Small delay so reset() clears state before startPairing() sets it again
    setTimeout(() => startPairing(newChain), 50);
  }

  // Pre-select first address when session arrives
  useEffect(() => {
    if (session?.addresses.length) {
      setSelectedAddress(session.addresses[0]);
      setAccountName(session.peerName ?? "Mobile Wallet");
    }
  }, [session]);

  // Log + export when the success step actually renders.
  // Second auto-export fires here (300 ms after the effect runs) so the file
  // is guaranteed to include success_step_rendered — the first export (at
  // modal:save_success) may miss it due to the write-queue → render → effect
  // timing race (effect fires after React paint, which can coincide with the
  // 300 ms save_success export timer).
  useEffect(() => {
    if (savedAccount) {
      appendDebugLog("modal:success_step_rendered", {
        address: sanitizeAddress(savedAccount.address),
      });
      if (DEBUG_EXPORT) setTimeout(exportDebugLog, 300);
    }
  }, [savedAccount]);

  async function handleConfirm() {
    if (!session || !selectedAddress) return;
    appendDebugLog("modal:confirm_start", {
      address: sanitizeAddress(selectedAddress),
      topic: sanitizeTopic(session.topic),
    });
    setSaveError(null);
    setSaving(true);
    try {
      const id = crypto.randomUUID();
      const account: Account = {
        id,
        name: accountName.trim() || session.peerName,
        address: selectedAddress,
        type: "walletconnect",
        wcSessionTopic: session.topic,
        wcPeerName: session.peerName,
        wcChain: activeChain,  // chain explicitly selected by user in this modal
      };

      // Use callback-based storage API with timeout — surfaces errors instead of
      // hanging forever (e.g. if the extension context was invalidated by a reload
      // while this window was already open).
      const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          "chrome.storage timed out (5 s).\n\n" +
          "Close this window, reload the extension, then try Connect again."
        )), 5000);
        try {
          chrome.storage.local.get(STORAGE_KEY_META, (result) => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(result);
          });
        } catch (e) { clearTimeout(timer); reject(e); }
      });
      appendDebugLog("modal:storage_read_ok");

      const meta: WalletMeta = (stored[STORAGE_KEY_META] as WalletMeta | undefined) ?? {
        accounts: [],
        activeAccountId: null,
        activeChain: "algorand",
        connectedSites: {},
        initialized: true,
      };

      // Reject duplicate WalletConnect account for the same address
      if (meta.accounts.some((a) => a.type === "walletconnect" && a.address === selectedAddress)) {
        appendDebugLog("modal:duplicate_address", { address: sanitizeAddress(selectedAddress) });
        throw new Error("This address is already added as a WalletConnect account.");
      }

      meta.accounts.push(account);
      meta.activeAccountId = id;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          "chrome.storage write timed out (5 s). Close and try again."
        )), 5000);
        try {
          chrome.storage.local.set({ [STORAGE_KEY_META]: meta }, () => {
            clearTimeout(timer);
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve();
          });
        } catch (e) { clearTimeout(timer); reject(e); }
      });
      appendDebugLog("modal:storage_write_ok", { topic: sanitizeTopic(session.topic) });

      // Clear the dedup guard. Do NOT call onConnected here — in the WalletSetup
      // inline path onConnected calls onComplete() which triggers setView("wallet")
      // in App.tsx. React batches that with setSavedAccount below and unmounts
      // WalletConnectModal in the same render cycle, so the success step never
      // renders and success_step_rendered never fires. onConnected is deferred
      // to the "Done" button so the parent transition only happens after the user
      // has seen the confirmation and explicitly dismissed the modal.
      chrome.storage.local.remove(WC_PAIR_TAB_KEY);
      appendDebugLog("modal:save_success", { address: sanitizeAddress(account.address) });
      // Auto-export: captures the full save flow before the user closes the tab.
      // 300 ms delay gives the write queue time to flush save_success to storage.
      if (DEBUG_EXPORT) setTimeout(exportDebugLog, 300);
      setSavedAccount(account);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save account";
      setSaveError(msg);
      // Auto-export: captures duplicate_address, storage errors, etc.
      if (DEBUG_EXPORT) setTimeout(exportDebugLog, 300);
    } finally {
      setSaving(false);
    }
  }

  // ── Determine current step ────────────────────────────────────────────────

  const step: "qr" | "waiting" | "confirm" | "error" | "success" =
    savedAccount ? "success" :
    error ? "error" :
    session ? "confirm" :
    qrDataUrl ? "qr" :
    "waiting";

  const chainLabel = activeChain === "voi" ? "Voi" : "Algorand";
  const walletLabel = WALLET_LABELS[activeChain] ?? WALLET_LABELS["algorand"];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface-1 rounded-2xl p-5 w-[320px] mx-auto shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-base font-semibold">Connect Mobile Wallet</h2>
            <p className="text-xs text-gray-500 mt-0.5">{walletLabel}</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Chain badge */}
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
              activeChain === "voi"
                ? "bg-purple-500/10 text-purple-300 border-purple-500/30"
                : "bg-algo/10 text-algo border-algo/30"
            }`}>
              {chainLabel}
            </span>
            <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
          </div>
        </div>

        {/* ── Step: QR code ── */}
        {step === "qr" && (
          <div className="text-center">
            {/* Explicit chain selector — user must confirm which chain before scanning */}
            <p className="text-xs text-gray-400 mb-2">Select the chain for this wallet</p>
            <div className="flex gap-2 justify-center mb-3">
              <button
                onClick={() => handleSwitchChain("algorand")}
                className={`flex-1 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                  activeChain === "algorand"
                    ? "bg-algo/20 text-algo border-algo/40"
                    : "bg-surface-2 text-gray-400 border-surface-3 hover:text-white"
                }`}
              >
                Algorand
              </button>
              <button
                onClick={() => handleSwitchChain("voi")}
                className={`flex-1 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                  activeChain === "voi"
                    ? "bg-purple-500/20 text-purple-300 border-purple-500/30"
                    : "bg-surface-2 text-gray-400 border-surface-3 hover:text-white"
                }`}
              >
                Voi
              </button>
            </div>

            <p className="text-xs text-gray-400 mb-3">
              Open your wallet app and scan this QR code
            </p>
            <div className="bg-white rounded-xl p-2 inline-block mb-3">
              <img src={qrDataUrl!} alt="WalletConnect QR" className="w-[240px] h-[240px]" />
            </div>

            {/* Supported wallets chips */}
            <div className="flex flex-wrap gap-1.5 justify-center mb-3">
              {activeChain === "algorand" ? (
                <>
                  <WalletChip name="Pera" color="blue" />
                  <WalletChip name="Defly" color="green" />
                  <WalletChip name="Lute" color="algo" />
                </>
              ) : (
                <WalletChip name="Lute" color="algo" />
              )}
            </div>

            {wcUri && (
              <button
                className="text-xs text-algo underline mb-3 block mx-auto"
                onClick={() => navigator.clipboard.writeText(wcUri)}
              >
                Copy link instead
              </button>
            )}
            <p className="text-xs text-gray-500">Waiting for you to scan…</p>
          </div>
        )}

        {/* ── Step: Waiting for wallet approval ── */}
        {step === "waiting" && (
          <div className="text-center py-8">
            <div className="w-8 h-8 border-2 border-algo border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-sm text-gray-400">Connecting to relay…</p>
          </div>
        )}

        {/* ── Step: Confirm account ── */}
        {step === "confirm" && session && (
          <div>
            {/* Wallet badge */}
            <div className="flex items-center gap-3 bg-surface-2 rounded-xl px-3 py-2.5 mb-4">
              {session.peerIcon && (
                <img src={session.peerIcon} alt="" className="w-8 h-8 rounded-lg" />
              )}
              <div>
                <p className="text-sm font-semibold">{session.peerName}</p>
                <p className="text-xs text-green-400">✓ Connected on {chainLabel}</p>
              </div>
            </div>

            {/* Address picker */}
            {session.addresses.length > 1 && (
              <>
                <label className="block text-xs text-gray-400 mb-1">Account address</label>
                <select
                  className="w-full bg-surface-2 rounded-xl px-3 py-2 text-xs font-mono mb-3 outline-none"
                  value={selectedAddress}
                  onChange={(e) => setSelectedAddress(e.target.value)}
                >
                  {session.addresses.map((a) => (
                    <option key={a} value={a}>{a.slice(0, 16)}…{a.slice(-6)}</option>
                  ))}
                </select>
              </>
            )}

            {session.addresses.length === 1 && (
              <div className="mb-3">
                <label className="block text-xs text-gray-400 mb-1">Address</label>
                <p className="text-xs font-mono bg-surface-2 rounded-xl px-3 py-2 break-all">
                  {selectedAddress}
                </p>
              </div>
            )}

            {/* Account name */}
            <label className="block text-xs text-gray-400 mb-1">Account name</label>
            <input
              className="w-full bg-surface-2 rounded-xl px-3 py-2 text-sm mb-4 outline-none focus:ring-1 focus:ring-algo"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
              placeholder="e.g. Pera Account 1"
            />

            {saveError && (
              <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2 mb-3 border border-red-500/20">
                {saveError}
              </p>
            )}

            <button
              onClick={handleConfirm}
              disabled={saving || !selectedAddress}
              className="w-full py-2.5 rounded-xl bg-algo text-black text-sm font-semibold disabled:opacity-40 hover:bg-algo/90 transition-colors"
            >
              {saving ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />
                  Saving…
                </span>
              ) : "Add Account"}
            </button>
          </div>
        )}

        {/* ── Step: Success ── */}
        {step === "success" && savedAccount && (
          <div className="text-center py-4">
            <div className="w-12 h-12 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-2xl">✓</span>
            </div>
            <p className="text-sm font-semibold text-green-400 mb-1">Account added</p>
            <p className="text-sm font-medium mb-2">{savedAccount.name}</p>
            <p className="text-xs font-mono text-gray-400 bg-surface-2 rounded-lg px-3 py-2 mb-5 break-all">
              {savedAccount.address}
            </p>
            <button
              onClick={() => {
                appendDebugLog("modal:done_click");
                // Notify the parent now — deferred from handleConfirm to here so
                // the success step has already rendered before any parent-triggered
                // view change (e.g. WalletSetup onComplete → setView("wallet"))
                // can unmount this component.
                onConnected(savedAccount!);
                chrome.tabs.getCurrent((tab) => {
                  appendDebugLog("modal:getCurrent_result", { tabId: tab?.id ?? null });
                  if (tab?.id !== undefined) {
                    appendDebugLog("modal:tabs_remove_called", { tabId: tab.id });
                    chrome.tabs.remove(tab.id, () => {
                      // Callback only fires if remove FAILED (tab still open).
                      // On success, page context is destroyed before this runs.
                      if (chrome.runtime.lastError) {
                        appendDebugLog("modal:tabs_remove_last_error", {
                          err: chrome.runtime.lastError.message,
                        });
                        // Auto-export: tab is still open so download can complete.
                        if (DEBUG_EXPORT) setTimeout(exportDebugLog, 300);
                      }
                    });
                  } else {
                    // Action-popup path — onConnected caller handles close
                    // (WC_PAIR_MODE: App.tsx calls window.close() via onConnected;
                    //  WalletSetup inline: onConnected navigates to AccountView).
                    appendDebugLog("modal:no_tab_caller_handles_close");
                  }
                });
              }}
              className="w-full py-2.5 rounded-xl bg-algo text-black text-sm font-semibold hover:bg-algo/90 transition-colors"
            >
              Done
            </button>
          </div>
        )}

        {/* ── Step: Error ── */}
        {step === "error" && (
          <div className="text-center py-4">
            <p className="text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-3 mb-4 border border-red-500/20 text-left whitespace-pre-line">
              {error}
            </p>
            <button
              onClick={() => { reset(); startPairing(activeChain); }}
              className="w-full py-2.5 rounded-xl bg-surface-2 text-sm font-medium hover:bg-white/10 transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function WalletChip({ name, color }: { name: string; color: "blue" | "green" | "algo" }) {
  const styles = {
    blue: "bg-blue-500/10 border-blue-500/20 text-blue-300",
    green: "bg-green-500/10 border-green-500/20 text-green-300",
    algo: "bg-algo/10 border-algo/20 text-algo",
  };
  return (
    <span className={`inline-flex items-center border rounded-full px-2.5 py-1 text-xs font-medium ${styles[color]}`}>
      {name}
    </span>
  );
}
