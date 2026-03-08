import { useEffect, useState } from "react";
import WalletSetup from "./components/WalletSetup";
import AccountView from "./components/AccountView";
import WalletConnectModal from "./components/WalletConnectModal";
import { CHAINS } from "@shared/constants";
import type { LockState } from "@shared/types/wallet";
import type { ChainId } from "@shared/types/chain";

// Detect whether this window was opened for WalletConnect pairing
const _wcParams = new URLSearchParams(window.location.search);
const WC_PAIR_MODE = _wcParams.get("wcpair") === "1";
// H2: Validate the chain param at runtime — a TypeScript cast alone won't catch
// garbage values injected via URL manipulation. Fall back to "algorand" if the
// value is not a key in the supported CHAINS map.
const _rawWCChain = _wcParams.get("chain") ?? "algorand";
const WC_PAIR_CHAIN: ChainId = _rawWCChain in CHAINS ? (_rawWCChain as ChainId) : "algorand";


function sendBg<T = unknown>(msg: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: { ok: boolean; data: T; error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res.ok) resolve(res.data);
      else reject(new Error(res.error));
    });
  });
}

export { sendBg };

type View = "loading" | "setup" | "unlock" | "wallet";

export default function App() {
  const [view, setView] = useState<View>("loading");
  const [, setLockState] = useState<LockState>("locked");  // value unused; view drives rendering

  useEffect(() => {
    sendBg<{ lockState: LockState }>({ type: "WALLET_STATE" })
      .then(({ lockState: ls }) => {
        setLockState(ls);
        if (ls === "uninitialized") setView("setup");
        else if (ls === "unlocked") setView("wallet");
        else setView("unlock");
      })
      .catch(() => setView("setup"));

    // Listen for lock state changes from background
    const listener = (msg: { type: string; lockState?: LockState }) => {
      if (msg.type === "LOCK_STATE_CHANGED" && msg.lockState) {
        if (msg.lockState === "locked") {
          // L5*: Best-effort — clear WC SDK session data from popup localStorage
          // on lock so a physical-access attacker cannot read cached session keys
          // from DevTools. Only effective while the popup is open; closing the
          // popup without locking leaves the data intact (acceptable trade-off).
          Object.keys(localStorage)
            .filter((k) => k.startsWith("wc@2:"))
            .forEach((k) => localStorage.removeItem(k));
        }
        setLockState(msg.lockState);
        setView(msg.lockState === "unlocked" ? "wallet" : "unlock");
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  if (view === "loading") {
    return (
      <div className="flex items-center justify-center h-40">
        <div className="w-6 h-6 border-2 border-algo border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (view === "setup") {
    return <WalletSetup onComplete={() => setView("wallet")} />;
  }

  if (view === "unlock") {
    return <UnlockScreen onUnlocked={() => setView("wallet")} />;
  }

  // WC pairing window: show modal directly, close on done/cancel
  if (WC_PAIR_MODE) {
    return (
      <div className="relative min-h-[560px]">
        <WalletConnectModal
          chain={WC_PAIR_CHAIN}
          onConnected={() => { window.close(); }}
          onClose={() => { window.close(); }}
        />
      </div>
    );
  }

  return <AccountView />;
}

function UnlockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleUnlock(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await sendBg({ type: "WALLET_UNLOCK", password });
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wrong password");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[400px] p-6 gap-6">
      <div className="flex flex-col items-center gap-2">
        <div className="w-12 h-12 bg-algo rounded-xl flex items-center justify-center text-black font-bold text-xl">
          AV
        </div>
        <h1 className="text-xl font-bold text-white">AlgoVoi</h1>
        <p className="text-sm text-gray-400">Enter your password to unlock</p>
      </div>
      <form onSubmit={handleUnlock} className="w-full flex flex-col gap-3">
        <input
          type="password"
          className="input"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
        />
        {error && <p className="text-red-400 text-sm">{error}</p>}
        <button type="submit" className="btn-primary w-full" disabled={loading || !password}>
          {loading ? "Unlocking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}
