import { useEffect, useState, useCallback } from "react";
import { readAssetCache, writeAssetCache } from "@shared/utils/asset-cache";
import algosdk from "algosdk";
import QRCode from "qrcode";
import ChainToggle from "./ChainToggle";
import AssetList from "./AssetList";
import { sendBg } from "../App";
import { abbreviateAddress, formatAmount } from "@shared/utils/format";
import { CHAINS, STORAGE_KEY_META, WC_PAIR_TAB_KEY } from "@shared/constants";
import { useWalletConnect } from "../hooks/useWalletConnect";
import VaultPanel from "./VaultPanel";
import SwapPanel from "./SwapPanel";
import type { WalletMeta, Account } from "@shared/types/wallet";
import type { AccountState, AccountAsset } from "@shared/types/chain";
import type { ChainId } from "@shared/types/chain";

type Tab = "assets" | "swap" | "history" | "apps" | "agents" | "vault";
type Modal = "send" | "receive" | null;

/**
 * Parse a decimal string to atomic BigInt without float rounding errors.
 * H1: Mirrors background parseDecimalToAtomic — used in the WalletConnect signing
 * path where the frontend builds the unsigned txn directly (amtAtomic is passed to
 * algosdk, not re-parsed by the background).  Float math (10 ** 18) loses precision
 * for ≥16-decimal tokens.
 */
function parseDecimalAmount(amount: string, decimals: number): bigint {
  const clean = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error("Invalid amount");
  const [intStr, fracStr = ""] = clean.split(".");
  const fracPadded = fracStr.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(intStr) * BigInt(10 ** decimals) + BigInt(fracPadded);
}

/**
 * Convert an atomic BigInt balance to a decimal string without floating-point loss.
 * M3: Replaces Number(atomic) / 10**dec which loses precision for balances > 2^53
 * (e.g. a token with 18 decimals and a large balance).
 */
function bigIntToDecimalStr(atomic: bigint, dec: number): string {
  if (dec === 0) return atomic.toString();
  const divisor = BigInt(10 ** dec);
  const intPart = atomic / divisor;
  const fracPart = atomic % divisor;
  return `${intPart}.${fracPart.toString().padStart(dec, "0")}`;
}

/**
 * Open WalletConnect pairing in a dedicated browser tab so the WC relay
 * WebSocket survives focus loss (Chrome auto-closes action popups on blur).
 *
 * Dedup guard: if a WC pair tab is already open, re-focus it instead of
 * opening a duplicate.  The tab ID is stored in chrome.storage.local under
 * WC_PAIR_TAB_KEY and cleared by WalletConnectModal after the flow completes.
 */
function openWCPairTab(chain: ChainId) {
  const url =
    chrome.runtime.getURL("src/popup/index.html") +
    `?wcpair=1&chain=${chain}`;

  chrome.storage.local.get(WC_PAIR_TAB_KEY, (stored) => {
    const existingId =
      typeof stored[WC_PAIR_TAB_KEY] === "number"
        ? (stored[WC_PAIR_TAB_KEY] as number)
        : null;

    if (existingId !== null) {
      // Verify the stored tab is still open
      chrome.tabs.get(existingId, (tab) => {
        if (!chrome.runtime.lastError && tab) {
          // Tab is alive — bring it to the front
          chrome.tabs.update(existingId, { active: true });
          if (tab.windowId !== undefined) {
            chrome.windows.update(tab.windowId, { focused: true });
          }
          return;
        }
        // Stored ID is stale — clear it and open a new tab
        chrome.storage.local.remove(WC_PAIR_TAB_KEY);
        createPairTab(url);
      });
      return;
    }

    createPairTab(url);
  });
}

function createPairTab(url: string) {
  chrome.tabs.create({ url }, (tab) => {
    if (tab?.id !== undefined) {
      chrome.storage.local.set({ [WC_PAIR_TAB_KEY]: tab.id });
    }
  });
}

/**
 * Fetch account state directly from algonode — no chrome.runtime.sendMessage.
 * This avoids the freeze that occurs when the WC relay WebSocket is still alive
 * in the popup's JS context right after pairing.
 *
 * ASA metadata (name, unitName, decimals) is immutable on-chain and cached
 * permanently in chrome.storage.local. Only balances are fetched live.
 * On repeat opens the API call count is: 1 (account info) + N_uncached (new ASAs).
 */
async function fetchChainStateDirect(
  address: string,
  chain: ChainId
): Promise<AccountState> {
  const cfg  = CHAINS[chain];
  const algod = new algosdk.Algodv2(cfg.algod.token, cfg.algod.url, cfg.algod.port);

  // ── 1. Fetch live account data (balances + held asset IDs) ──────────────
  const info = await algod.accountInformation(address).do();
  const holdings: algosdk.modelsv2.AssetHolding[] =
    (info as { assets?: algosdk.modelsv2.AssetHolding[] }).assets ?? [];

  // ── 2. Read metadata cache; find which ASAs are missing ─────────────────
  const cache = await readAssetCache(chain);
  const uncached = holdings.filter((h) => !cache[String(h.assetId)]);

  // ── 3. Fetch metadata only for uncached ASAs (typically 0 on repeat opens) ──
  if (uncached.length > 0) {
    const BATCH = 5;
    const fetched: Record<number, import("@shared/utils/asset-cache").AssetMeta> = {};

    for (let i = 0; i < uncached.length; i += BATCH) {
      const chunk = uncached.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        chunk.map((h) => algod.getAssetByID(Number(h.assetId)).do())
      );
      results.forEach((result, j) => {
        const assetId = Number(chunk[j].assetId);
        const params = result.status === "fulfilled" ? result.value.params : undefined;
        fetched[assetId] = {
          name:     params?.name     ?? "",
          unitName: params?.unitName ?? "",
          decimals: Number(params?.decimals ?? 0),
        };
      });
      if (i + BATCH < uncached.length) {
        await new Promise<void>((r) => setTimeout(r, 150));
      }
    }

    // Persist new entries (fire-and-forget — non-blocking)
    writeAssetCache(chain, fetched).catch(() => { /* storage quota: best-effort */ });

    // Merge into local cache view so the rest of this call can use it
    for (const [id, meta] of Object.entries(fetched)) {
      cache[id] = meta;
    }
  }

  // ── 4. Build asset list from live balances + cached metadata ────────────
  const assets: AccountAsset[] = holdings.map((h) => {
    const meta = cache[String(h.assetId)];
    return {
      assetId:  Number(h.assetId),
      name:     meta?.name     ?? "",
      unitName: meta?.unitName ?? "",
      decimals: meta?.decimals ?? 0,
      amount:   h.amount,
      frozen:   h.isFrozen,
    };
  });

  return {
    address,
    chain,
    balance:    (info as { amount: bigint }).amount,
    assets,
    minBalance: (info as { minBalance: bigint }).minBalance,
    authAddr:   (info as { authAddr?: string }).authAddr ?? undefined,
  };
}

export default function AccountView() {
  const [meta, setMeta] = useState<WalletMeta | null>(null);
  const [chainState, setChainState] = useState<AccountState | null>(null);
  const [tab, setTab] = useState<Tab>("assets");
  const [modal, setModal] = useState<Modal>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const activeChain = (meta?.activeChain ?? "algorand") as ChainId;
  const activeAccount = meta?.accounts.find((a) => a.id === meta.activeAccountId);

  const loadState = useCallback(async () => {
    try {
      // Read meta directly from chrome.storage.local — avoids chrome.runtime.sendMessage
      // which can hang when the WalletConnect relay WebSocket is still alive in this
      // popup context (e.g. immediately after WC pairing completes in WalletSetup).
      const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("storage read timed out")),
          5000
        );
        chrome.storage.local.get(STORAGE_KEY_META, (result) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(result);
        });
      });
      const m: WalletMeta = (stored[STORAGE_KEY_META] as WalletMeta | undefined) ?? {
        accounts: [],
        activeAccountId: null,
        activeChain: "algorand",
        connectedSites: {},
        initialized: true,
      };
      setMeta(m);

      // Fetch chain state directly from algonode — non-blocking so the spinner
      // clears as soon as meta is ready, and avoids any sendMessage freeze.
      if (m.activeAccountId && m.accounts.length > 0) {
        const address = m.accounts.find((a) => a.id === m.activeAccountId)?.address;
        if (address) {
          fetchChainStateDirect(address, m.activeChain as ChainId)
            .then((state) => setChainState(state))
            .catch(() => { /* node unreachable — balance shows "—" */ });
        }
      }
    } catch (err) {
      console.error("Failed to load account state:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  // Refresh whenever any extension context writes to STORAGE_KEY_META —
  // e.g. when a WC pair tab adds a new account while this popup is open.
  useEffect(() => {
    function onStorageChange(
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) {
      if (area === "local" && STORAGE_KEY_META in changes) {
        loadState();
      }
    }
    chrome.storage.onChanged.addListener(onStorageChange);
    return () => chrome.storage.onChanged.removeListener(onStorageChange);
  }, [loadState]);

  // Switch chain by writing directly to storage — same approach as switchAccount.
  // This persists the preference across popup reopens AND ensures loadState() reads
  // the correct chain when triggered by the onStorageChange listener.
  // fetchChainStateDirect is chain-agnostic (uses CHAINS[chain]), so Voi assets
  // including aUSDC (ASA 302190) resolve automatically via getAssetByID.
  function handleChainChange(chain: ChainId) {
    if (!meta) return;
    // Optimistic UI: update toggle + clear stale balance immediately
    setMeta({ ...meta, activeChain: chain });
    setChainState(null);
    // Persist to storage → triggers onStorageChange → loadState() → fetchChainStateDirect
    chrome.storage.local.get(STORAGE_KEY_META, (result) => {
      const m = result[STORAGE_KEY_META] as WalletMeta | undefined;
      if (m) {
        chrome.storage.local.set({ [STORAGE_KEY_META]: { ...m, activeChain: chain } });
      }
    });
  }

  async function handleLock() {
    await sendBg({ type: "WALLET_LOCK" });
  }

  // Switch active account by writing directly to storage (avoids sendMessage,
  // which may still be throttled right after WC pairing).
  // The onStorageChange listener will call loadState() automatically.
  function switchAccount(id: string) {
    chrome.storage.local.get(STORAGE_KEY_META, (result) => {
      const m = result[STORAGE_KEY_META] as WalletMeta | undefined;
      if (m) {
        chrome.storage.local.set({ [STORAGE_KEY_META]: { ...m, activeAccountId: id } });
      }
    });
  }

  async function handleRemoveAccount() {
    if (!activeAccount) return;
    const label = `Remove "${activeAccount.name}" (${activeAccount.address.slice(0, 8)}…)?`;
    // eslint-disable-next-line no-alert
    if (!window.confirm(label)) return;
    try {
      await sendBg({ type: "WALLET_REMOVE_ACCOUNT", id: activeAccount.id });
      loadState();
    } catch (err) {
      console.error("Failed to remove account:", err);
    }
  }

  function copyAddress() {
    if (!activeAccount) return;
    navigator.clipboard.writeText(activeAccount.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-5 h-5 border-2 border-algo border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // ── Empty wallet (WC-only setup, no accounts yet) ─────────────────────────
  if (!meta?.accounts.length) {
    return (
      <div className="flex flex-col min-h-[560px]">
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-algo rounded-md flex items-center justify-center text-black text-xs font-bold">
              AV
            </div>
            <span className="text-sm font-semibold">AlgoVoi</span>
          </div>
          <button onClick={handleLock} className="text-xs text-gray-400 hover:text-white transition-colors">
            Lock
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-5 text-center">
          <div className="w-16 h-16 rounded-2xl bg-algo/10 border border-algo/20 flex items-center justify-center text-3xl">
            📱
          </div>
          <div>
            <h2 className="font-semibold mb-1">No accounts yet</h2>
            <p className="text-xs text-gray-400">
              Connect your Pera, Defly, or Lute wallet via QR code to get started.
            </p>
          </div>
          <button
            onClick={() => openWCPairTab(activeChain)}
            className="w-full py-3 rounded-xl bg-algo text-black text-sm font-semibold hover:bg-algo/90 transition-colors"
          >
            + Connect Mobile Wallet
          </button>
        </div>

        {/* WalletConnect pairing opens in a dedicated tab via openWCPairTab() */}
      </div>
    );
  }

  const cfg = CHAINS[activeChain];

  return (
    <div className="flex flex-col min-h-[560px]">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-algo rounded-md flex items-center justify-center text-black text-xs font-bold">
            AV
          </div>
          <span className="text-sm font-semibold">AlgoVoi</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => openWCPairTab(activeChain)}
            className="text-xs text-algo hover:text-algo/80 transition-colors"
            title="Connect mobile wallet via QR"
          >
            + Connect
          </button>
          <button onClick={handleLock} className="text-xs text-gray-400 hover:text-white transition-colors">
            Lock
          </button>
        </div>
      </div>

      {/* Chain toggle */}
      <div className="px-4 py-2">
        <ChainToggle activeChain={activeChain} onChange={handleChainChange} />
      </div>

      {/* Account selector — only shown when more than one account exists */}
      {(meta?.accounts.length ?? 0) > 1 && (
        <div className="px-4 pb-2">
          <select
            className="w-full bg-surface-2 text-xs rounded-lg px-3 py-1.5 outline-none cursor-pointer"
            value={meta?.activeAccountId ?? ""}
            onChange={(e) => switchAccount(e.target.value)}
          >
            {meta?.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.address.slice(0, 6)}…{a.address.slice(-4)}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Account card */}
      <div className={`mx-4 rounded-xl p-4 ${activeChain === "algorand" ? "bg-gradient-to-br from-algo/20 to-surface-1" : "bg-gradient-to-br from-voi/20 to-surface-1"}`}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="flex items-center gap-1.5">
              <p className="text-xs text-gray-400">{activeAccount?.name ?? "Account"}</p>
              {activeAccount?.type === "walletconnect" && (
                <span className="text-xs bg-purple-500/20 text-purple-300 border border-purple-500/30 rounded px-1 py-0 leading-4">
                  {activeAccount.wcPeerName ?? "WC"}
                  {activeAccount.wcChain && (
                    <span className={`ml-1 ${activeAccount.wcChain === "voi" ? "text-voi" : "text-algo"}`}>
                      · {CHAINS[activeAccount.wcChain].name}
                    </span>
                  )}
                </span>
              )}
              <button
                onClick={handleRemoveAccount}
                className="text-[10px] text-red-400/50 hover:text-red-400 transition-colors leading-none"
                title="Remove this account"
              >
                ✕
              </button>
            </div>
            <button
              onClick={copyAddress}
              className="text-xs text-gray-300 hover:text-white transition-colors font-mono"
              title="Copy address"
            >
              {activeAccount ? abbreviateAddress(activeAccount.address) : "—"}
              {copied ? " ✓" : " ⎘"}
            </button>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold">
              {chainState ? formatAmount(chainState.balance, cfg.decimals) : "—"}
            </p>
            <p className="text-sm text-gray-400">{cfg.ticker}</p>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex gap-2">
          <button
            onClick={() => setModal("send")}
            className="flex-1 bg-white/10 hover:bg-white/15 rounded-lg py-1.5 text-xs font-medium transition-colors"
          >
            Send
          </button>
          <button
            onClick={() => setModal("receive")}
            className="flex-1 bg-white/10 hover:bg-white/15 rounded-lg py-1.5 text-xs font-medium transition-colors"
          >
            Receive
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex px-4 pt-4 gap-1 border-b border-surface-2 mb-3">
        {(activeChain === "algorand"
          ? ["assets", "swap", "history", "apps", "agents", "vault"]
          : ["assets", "history", "apps", "agents", "vault"]
        ).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t as Tab)}
            className={`text-xs font-medium px-2 py-1.5 rounded-t-md capitalize transition-colors ${
              tab === t
                ? "text-white border-b-2 border-algo"
                : "text-gray-400 hover:text-white"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {tab === "assets" && (
          <AssetList
            chain={activeChain}
            balance={chainState?.balance ?? 0n}
            assets={chainState?.assets ?? []}
          />
        )}
        {tab === "swap" && activeAccount && (
          <SwapPanel
            activeAccount={activeAccount}
            balance={chainState?.balance ?? 0n}
            assets={chainState?.assets ?? []}
          />
        )}
        {tab === "history" && (
          <div className="text-xs text-gray-500 text-center py-6">
            Transaction history coming in Phase 2
          </div>
        )}
        {tab === "apps" && (
          <ConnectedAppsTab connectedSites={meta?.connectedSites ?? {}} onUpdate={loadState} />
        )}
        {tab === "agents" && (
          <AgentsTab
            isVaultAccount={activeAccount?.type !== "walletconnect"}
          />
        )}
        {tab === "vault" && (
          <VaultPanel chain={activeChain} activeAccount={activeAccount} />
        )}
      </div>

      {/* Modals */}
      {modal === "send" && activeAccount && (
        <SendModal
          chain={activeChain}
          ticker={cfg.ticker}
          balance={chainState?.balance ?? 0n}
          decimals={cfg.decimals}
          assets={chainState?.assets ?? []}
          activeAccount={activeAccount}
          onClose={() => setModal(null)}
          onSent={() => { setModal(null); setTimeout(loadState, 2000); }}
        />
      )}
      {modal === "receive" && activeAccount && (
        <ReceiveModal
          address={activeAccount.address}
          chain={activeChain}
          ticker={cfg.ticker}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ── Send Modal ────────────────────────────────────────────────────────────────

function SendModal({
  chain,
  ticker,
  balance,
  decimals,
  assets,
  activeAccount,
  onClose,
  onSent,
}: {
  chain: ChainId;
  ticker: string;
  balance: bigint;
  decimals: number;
  assets: AccountAsset[];
  activeAccount: Account;
  onClose: () => void;
  onSent: () => void;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txId, setTxId] = useState<string | null>(null);

  // Asset selector — null = native coin
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);

  // enVoi name resolution (Voi only)
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // WC signing (only used for walletconnect accounts)
  const { signTransaction } = useWalletConnect();

  const selectedAsset = selectedAssetId !== null
    ? assets.find((a) => a.assetId === selectedAssetId) ?? null
    : null;
  const sendBalance  = selectedAsset ? selectedAsset.amount   : balance;
  const sendDecimals = selectedAsset ? selectedAsset.decimals : decimals;
  const sendTicker   = selectedAsset
    ? (selectedAsset.unitName || selectedAsset.name || `#${selectedAsset.assetId}`)
    : ticker;
  const availableDisplay = formatAmount(sendBalance, sendDecimals);
  const isWC = activeAccount.type === "walletconnect";

  /**
   * Match a .voi name on the Voi chain.
   * Accepts both bare labels ("shelly") and fully-qualified names ("shelly.voi").
   * A plain 58-char address is never treated as a name.
   */
  function isVoiName(s: string): boolean {
    if (chain !== "voi") return false;
    const t = s.trim();
    if (/^[A-Z2-7]{58}$/.test(t)) return false; // plain address — skip
    return /^[a-zA-Z0-9-]+(\.voi)?$/i.test(t);
  }

  function validateAddress(addr: string): boolean {
    return /^[A-Z2-7]{58}$/.test(addr);
  }

  async function handleResolve() {
    setResolveError(null);
    setResolvedAddress(null);
    setResolving(true);
    try {
      const { address } = await sendBg<{ address: string; displayName: string }>({
        type: "VOI_RESOLVE_NAME",
        name: to.trim(),
      });
      setResolvedAddress(address);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Resolution failed");
    } finally {
      setResolving(false);
    }
  }

  async function handleSend() {
    setError(null);
    const trimTo = resolvedAddress ?? to.trim();
    const trimAmt = amount.trim();

    // If the user typed a .voi name but hasn't resolved it yet, block send
    if (isVoiName(to.trim()) && !resolvedAddress) {
      setError("Resolve the .voi name before sending");
      return;
    }

    if (!trimTo || !validateAddress(trimTo)) {
      setError("Invalid recipient address (must be a 58-character Algorand/Voi address)");
      return;
    }
    const amtNum = parseFloat(trimAmt);
    if (isNaN(amtNum) || amtNum <= 0) {
      setError("Enter a valid amount greater than 0");
      return;
    }
    // H1: Use string-based parser (no float rounding) for the atomic amount.
    // This matters most in the WC path where amtAtomic is passed directly to algosdk.
    // The mnemonic path sends trimAmt as a string to the background (background re-parses),
    // but using the same helper keeps both paths consistent.
    const amtAtomic = parseDecimalAmount(trimAmt, sendDecimals);
    // For ASA: fee is paid in native coin, so the full ASA balance is sendable.
    // For native coin: reserve 1000 atomic units for the minimum fee.
    const MIN_FEE = BigInt(1000);
    if (selectedAsset) {
      if (amtAtomic > sendBalance) {
        setError(`Insufficient ${sendTicker} balance (available: ${availableDisplay} ${sendTicker})`);
        return;
      }
    } else {
      if (amtAtomic + MIN_FEE > balance) {
        setError(`Insufficient balance (available: ${availableDisplay} ${ticker})`);
        return;
      }
    }

    setSending(true);
    try {
      if (isWC && activeAccount.wcSessionTopic) {
        // ── WalletConnect signing path ────────────────────────────────────────
        // WC sessions are chain-specific: a session approved for Algorand cannot
        // sign Voi transactions (the WC SDK rejects the chainId).
        // wcChain records which chain the session was established on; fall back
        // to "algorand" for accounts created before this field was added.
        const accountChain = (activeAccount.wcChain ?? chain) as ChainId;
        // Only block when wcChain is explicitly recorded and mismatches the active chain.
        // Accounts created before this field was added (wcChain undefined) skip the guard
        // and let the WC SDK validate the session namespaces directly.
        if (activeAccount.wcChain !== undefined && accountChain !== chain) {
          setError(
            `This account was connected on ${CHAINS[accountChain].name}. ` +
            `Use the chain toggle (top right) to switch to ${CHAINS[accountChain].name} before sending.`
          );
          return;
        }
        // 1. Get suggested params via algod (popup calls algonode directly)
        const cfg = CHAINS[chain];
        const algod = new algosdk.Algodv2("", cfg.algod.url, cfg.algod.port);
        const params = await algod.getTransactionParams().do();
        // 2. Build unsigned txn
        const noteBytes = note.trim() ? new TextEncoder().encode(note.trim()) : undefined;
        const txn = selectedAsset
          ? algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
              sender: activeAccount.address,
              receiver: trimTo,
              assetIndex: selectedAsset.assetId,
              amount: amtAtomic,
              note: noteBytes,
              suggestedParams: params,
            })
          : algosdk.makePaymentTxnWithSuggestedParamsFromObject({
              sender: activeAccount.address,
              receiver: trimTo,
              amount: amtAtomic,
              note: noteBytes,
              suggestedParams: params,
            });
        // 3. Sign on phone via WC — use accountChain (not chain) to guarantee the
        //    CAIP-2 chainId matches what the session was approved for.
        const signedBytes = await signTransaction(
          activeAccount.wcSessionTopic,
          accountChain,
          txn,
          activeAccount.address
        );
        // 4. Submit pre-signed bytes via background
        const { txId: id } = await sendBg<{ txId: string }>({
          type: "CHAIN_SUBMIT_SIGNED",
          signedTxn: btoa(String.fromCharCode(...signedBytes)),
          chain: accountChain,
        });
        setTxId(id);
      } else {
        // ── Mnemonic signing path (background holds the key) ─────────────────
        const { txId: id } = selectedAsset
          ? await sendBg<{ txId: string }>({
              type: "CHAIN_SEND_ASSET",
              to: trimTo,
              amount: trimAmt,
              assetId: selectedAsset.assetId,
              decimals: selectedAsset.decimals,
              chain,
              note: note.trim() || undefined,
            })
          : await sendBg<{ txId: string }>({
              type: "CHAIN_SEND_PAYMENT",
              to: trimTo,
              amount: trimAmt,
              chain,
              note: note.trim() || undefined,
            });
        setTxId(id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transaction failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-surface-1 rounded-2xl p-5 w-[320px] mx-auto shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Send {sendTicker}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Asset selector — only shown when account holds ASAs */}
        {assets.length > 0 && !txId && (
          <div className="mb-3">
            <label className="block text-xs text-gray-400 mb-1">Asset</label>
            <select
              value={selectedAssetId ?? "native"}
              onChange={(e) => {
                const val = e.target.value;
                setSelectedAssetId(val === "native" ? null : Number(val));
                setAmount("");
                setError(null);
              }}
              className="w-full bg-surface-2 rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-algo"
            >
              <option value="native">{ticker} (native)</option>
              {assets.map((a) => (
                <option key={a.assetId} value={a.assetId}>
                  {a.unitName || a.name || `Asset #${a.assetId}`} (#{a.assetId})
                </option>
              ))}
            </select>
          </div>
        )}

        {txId ? (
          /* ── Success state ── */
          <div className="text-center py-4">
            <div className="w-12 h-12 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-3">
              <span className="text-2xl">✓</span>
            </div>
            <p className="text-sm font-medium text-green-400 mb-1">Transaction submitted!</p>
            <p className="text-xs text-gray-500 mb-1">Transaction ID:</p>
            <p className="text-xs text-gray-300 font-mono break-all bg-surface-2 rounded-lg px-3 py-2 mb-4">{txId}</p>
            <button
              onClick={onSent}
              className="w-full py-2.5 rounded-xl bg-algo text-black text-sm font-semibold hover:bg-algo/90 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Recipient */}
            <label className="block text-xs text-gray-400 mb-1">
              Recipient
              {chain === "voi" && (
                <span className="text-gray-600 ml-1">or .voi name</span>
              )}
            </label>
            <input
              className="w-full bg-surface-2 rounded-xl px-3 py-2 text-xs font-mono outline-none focus:ring-1 focus:ring-voi placeholder-gray-600"
              placeholder={chain === "voi" ? "AAAA…AAAA or shelly.voi" : "AAAA…AAAA (58 characters)"}
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                // Clear resolved address whenever the input changes
                setResolvedAddress(null);
                setResolveError(null);
              }}
              autoComplete="off"
              spellCheck={false}
            />

            {/* enVoi resolve row — only shown when a .voi name is detected */}
            {isVoiName(to) && !resolvedAddress && (
              <div className="mt-1.5 mb-1">
                <button
                  type="button"
                  onClick={handleResolve}
                  disabled={resolving}
                  className="flex items-center gap-1.5 text-xs text-voi font-medium bg-voi/10 border border-voi/30 rounded-lg px-2.5 py-1 hover:bg-voi/20 transition-colors disabled:opacity-50"
                >
                  {resolving ? (
                    <>
                      <span className="w-3 h-3 border-2 border-voi border-t-transparent rounded-full animate-spin" />
                      Resolving…
                    </>
                  ) : (
                    <>
                      <span>🔍</span>
                      Resolve via enVoi <span className="text-gray-500 font-normal">(1 VOI)</span>
                    </>
                  )}
                </button>
                {resolveError && (
                  <p className="text-xs text-red-400 mt-1">{resolveError}</p>
                )}
              </div>
            )}

            {/* Resolved address confirmation */}
            {resolvedAddress && (
              <div className="mt-1.5 mb-1">
                <div className="flex items-start gap-1.5 bg-voi/10 border border-voi/30 rounded-lg px-2.5 py-1.5">
                  <span className="text-voi text-xs mt-0.5">✓</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-voi font-medium">{to.trim()}</p>
                    <p className="text-[10px] text-gray-400 font-mono truncate">{resolvedAddress}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => { setResolvedAddress(null); setResolveError(null); }}
                    className="text-gray-500 hover:text-white text-xs ml-1 shrink-0"
                  >
                    ×
                  </button>
                </div>
                {/* Security notice: address originates from a third-party service */}
                <p className="text-[10px] text-gray-600 mt-1 px-1">
                  ⚠ Address provided by mcp.ilovechicken.co.uk — verify before sending.
                </p>
              </div>
            )}

            <div className="mb-3" />

            {/* Amount */}
            <label className="block text-xs text-gray-400 mb-1">
              Amount{" "}
              <span className="text-gray-600">
                (available: {availableDisplay} {sendTicker})
              </span>
            </label>
            <div className="relative mb-3">
              <input
                className="w-full bg-surface-2 rounded-xl px-3 py-2 text-sm pr-16 outline-none focus:ring-1 focus:ring-algo"
                placeholder="0.000000"
                type="number"
                min="0"
                step="0.000001"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-algo font-semibold px-1"
                onClick={() => {
                  if (selectedAsset) {
                    // ASA: fee is in native coin — full ASA balance is sendable.
                    // M3: Use BigInt arithmetic to avoid precision loss for large balances.
                    setAmount(bigIntToDecimalStr(sendBalance, sendDecimals));
                  } else {
                    // Native coin: reserve min fee.
                    // M3: Use BigInt arithmetic to avoid precision loss for large balances.
                    const maxAtomic = balance > BigInt(1000) ? balance - BigInt(1000) : BigInt(0);
                    setAmount(bigIntToDecimalStr(maxAtomic, decimals));
                  }
                }}
              >
                MAX
              </button>
            </div>

            {/* Note */}
            <label className="block text-xs text-gray-400 mb-1">Note (optional)</label>
            <input
              className="w-full bg-surface-2 rounded-xl px-3 py-2 text-xs mb-4 outline-none focus:ring-1 focus:ring-algo placeholder-gray-600"
              placeholder="Optional memo"
              maxLength={1024}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />

            {error && (
              <p className="text-xs text-red-400 mb-3 bg-red-500/10 rounded-lg px-3 py-2 border border-red-500/20">
                {error}
              </p>
            )}

            <button
              onClick={handleSend}
              disabled={sending || !to || !amount}
              className="w-full py-2.5 rounded-xl bg-algo text-black text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-algo/90 transition-colors"
            >
              {sending ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />
                  Sending…
                </span>
              ) : (
                isWC
                  ? `Send ${sendTicker} via ${activeAccount.wcPeerName ?? "Mobile"}`
                  : `Send ${sendTicker}`
              )}
            </button>
          </>
        )}
      </div>
    </ModalOverlay>
  );
}

// ── Receive Modal ─────────────────────────────────────────────────────────────

function ReceiveModal({
  address,
  chain,
  ticker,
  onClose,
}: {
  address: string;
  chain: ChainId;
  ticker: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyFull() {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const explorerBase =
    chain === "algorand"
      ? "https://explorer.perawallet.app/address/"
      : "https://voi.observer/explorer/account/";

  return (
    <ModalOverlay onClose={onClose}>
      <div className="bg-surface-1 rounded-2xl p-5 w-[320px] mx-auto shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Receive {ticker}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>

        <p className="text-xs text-gray-500 text-center mb-3">
          Share this address to receive {ticker}
        </p>

        {/* Address box */}
        <div className="bg-surface-2 rounded-xl p-3 mb-4 border border-white/5">
          <p className="text-xs font-mono break-all text-gray-200 leading-relaxed select-all">{address}</p>
        </div>

        {/* Copy button */}
        <button
          onClick={copyFull}
          className="w-full py-2.5 rounded-xl bg-algo text-black text-sm font-semibold mb-3 hover:bg-algo/90 transition-colors"
        >
          {copied ? "✓ Copied!" : "Copy Address"}
        </button>

        {/* Explorer link */}
        <a
          href={`${explorerBase}${address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center text-xs text-algo hover:underline mb-4"
        >
          View on explorer ↗
        </a>

        <p className="text-xs text-gray-600 text-center">
          Only send {ticker} and {chain === "algorand" ? "Algorand (ARC-3/ARC-69)" : "Voi"} assets
          to this address.
        </p>
      </div>
    </ModalOverlay>
  );
}

// ── Modal Overlay ─────────────────────────────────────────────────────────────

function ModalOverlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

// ── Connected Apps Tab ────────────────────────────────────────────────────────

function ConnectedAppsTab({
  connectedSites,
  onUpdate,
}: {
  connectedSites: Record<string, string[]>;
  onUpdate: () => void;
}) {
  const entries = Object.entries(connectedSites);

  async function disconnect(origin: string) {
    await sendBg({ type: "ARC27_DISCONNECT", origin });
    onUpdate();
  }

  if (entries.length === 0) {
    return (
      <div className="text-xs text-gray-500 text-center py-6">No connected dApps</div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map(([origin, addresses]) => (
        <div
          key={origin}
          className="bg-surface-2 rounded-lg px-3 py-2.5 flex items-center justify-between"
        >
          <div>
            <p className="text-sm font-medium truncate max-w-[200px]">{origin}</p>
            <p className="text-xs text-gray-500">{addresses.length} address(es)</p>
          </div>
          <button
            onClick={() => disconnect(origin)}
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            Disconnect
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Agents Tab (WalletConnect Web3Wallet for AI agents) ───────────────────────

function AgentsTab({ isVaultAccount }: { isVaultAccount: boolean }) {
  const [sessions, setSessions] = useState<Record<string, Record<string, unknown>>>({});
  const [loading, setLoading]   = useState(true);
  const [generating, setGenerating] = useState(false);
  const [uri, setUri]           = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied]     = useState(false);
  const [error, setError]       = useState<string | null>(null);

  async function loadSessions() {
    setLoading(true);
    try {
      const res = await sendBg<{ sessions: Record<string, Record<string, unknown>> }>({ type: "W3W_GET_SESSIONS" });
      setSessions(res.sessions ?? {});
    } catch (e) {
      // Non-fatal — may fail if Web3Wallet not yet initialised
      setSessions({});
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadSessions(); }, []);

  async function handleGenerateUri() {
    setGenerating(true);
    setError(null);
    setUri(null);
    setQrDataUrl(null);
    try {
      const res = await sendBg<{ uri: string }>({ type: "W3W_GENERATE_URI" });
      setUri(res.uri);
      // Generate QR code as data URL for inline display
      try {
        const dataUrl = await QRCode.toDataURL(res.uri, { width: 240, margin: 1 });
        setQrDataUrl(dataUrl);
      } catch {
        // QR generation failed — fall back to URI-only display
      }
      await loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate URI");
    } finally {
      setGenerating(false);
    }
  }

  async function handleDisconnect(topic: string) {
    try {
      await sendBg({ type: "W3W_DISCONNECT", topic });
      setUri(null);
      setQrDataUrl(null);
      await loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Disconnect failed");
    }
  }

  function copyUri() {
    if (!uri) return;
    navigator.clipboard.writeText(uri);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const sessionEntries = Object.entries(sessions);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-4 h-4 border-2 border-algo border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isVaultAccount) {
    return (
      <div className="text-xs text-gray-500 text-center py-6 px-2">
        Agent connections require a vault (mnemonic) account. Switch to a vault account to connect AI agents.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Connected agents */}
      {sessionEntries.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-gray-400 uppercase tracking-wider">Connected Agents</p>
          {sessionEntries.map(([topic, session]) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const peer = (session as any)?.peer?.metadata ?? {};
            const name: string = peer.name ?? "Unknown Agent";
            const url: string  = peer.url  ?? "";
            return (
              <div
                key={topic}
                className="bg-surface-2 rounded-lg px-3 py-2.5 flex items-center justify-between"
              >
                <div className="flex-1 min-w-0 mr-2">
                  <p className="text-sm font-medium truncate">{name}</p>
                  {url && <p className="text-[10px] text-gray-500 truncate">{url}</p>}
                </div>
                <button
                  onClick={() => handleDisconnect(topic)}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors shrink-0"
                >
                  Disconnect
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Connect new agent */}
      {!uri && (
        <div className="flex flex-col gap-2">
          {sessionEntries.length === 0 && (
            <p className="text-xs text-gray-500 text-center py-2">
              No AI agents connected. Generate a pairing URI for an agent to connect.
            </p>
          )}
          <button
            onClick={handleGenerateUri}
            disabled={generating}
            className="w-full py-2.5 rounded-xl bg-algo text-black text-xs font-semibold hover:bg-algo/90 transition-colors disabled:opacity-50"
          >
            {generating ? "Generating…" : "+ Connect an AI Agent"}
          </button>
          <button
            onClick={loadSessions}
            className="w-full py-1.5 rounded-xl bg-surface-2 text-gray-400 text-xs hover:text-white transition-colors"
          >
            Refresh
          </button>
        </div>
      )}

      {/* QR code + URI display */}
      {uri && (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-gray-400 uppercase tracking-wider">Scan or copy this URI</p>
          {qrDataUrl && (
            <div className="flex justify-center">
              <img
                src={qrDataUrl}
                alt="WalletConnect pairing QR code"
                className="rounded-lg"
                width={200}
                height={200}
              />
            </div>
          )}
          <div className="bg-surface-2 rounded-lg p-2 flex flex-col gap-1.5">
            <p className="text-[9px] font-mono text-gray-400 break-all leading-relaxed line-clamp-3">
              {uri}
            </p>
            <button
              onClick={copyUri}
              className="text-xs text-algo hover:text-algo/80 transition-colors self-end"
            >
              {copied ? "Copied!" : "Copy URI"}
            </button>
          </div>
          <div className="bg-surface-2 border border-white/10 rounded-xl p-3">
            <p className="text-xs text-gray-400">
              Share this URI with the AI agent. After it connects, you will see an approval popup for each signing request.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => { setUri(null); setQrDataUrl(null); }}
              className="flex-1 py-2 rounded-xl bg-surface-2 text-gray-400 text-xs hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={loadSessions}
              className="flex-1 py-2 rounded-xl bg-surface-2 text-gray-400 text-xs hover:text-white transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-xl p-3">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      <div className="bg-surface-2 border border-white/10 rounded-xl p-3 mt-1">
        <p className="text-[10px] text-gray-500">
          AI agents connect as WalletConnect dApps. AlgoVoi signs transactions using your vault keys — you approve each request in a popup. Agents never access your private keys.
        </p>
      </div>
    </div>
  );
}
