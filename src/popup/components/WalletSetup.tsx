import { useState } from "react";
import algosdk from "algosdk";
import { sendBg } from "../App";
import WalletConnectModal from "./WalletConnectModal";
import type { Account } from "@shared/types/wallet";

type Step =
  | "choice"
  | "create"
  | "import"
  | "backup"
  | "confirm"
  | "wc_password"   // password prompt for WC-only wallet
  | "wc_connect";   // WalletConnect QR modal

export default function WalletSetup({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState<Step>("choice");
  const [mnemonic, setMnemonic] = useState<string>("");
  const [importMnemonic, setImportMnemonic] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [confirmPositions, setConfirmPositions] = useState<number[]>([]);
  const [confirmInputs, setConfirmInputs]       = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Generate mnemonic when entering create flow
  function startCreate() {
    const account = algosdk.generateAccount();
    setMnemonic(algosdk.secretKeyToMnemonic(account.sk));
    setStep("create");
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) return setError("Passwords do not match");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    setStep("backup");
  }

  function handleBackupConfirm() {
    // HIGH-03: Pick 4 distinct random indices from 0–24, sort ascending for display.
    const indices = new Set<number>();
    while (indices.size < 4) {
      indices.add(Math.floor(Math.random() * 25));
    }
    const sorted = [...indices].sort((a, b) => a - b);
    setConfirmPositions(sorted);
    setConfirmInputs(["", "", "", ""]);
    setStep("confirm");
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    const words = mnemonic.split(" ");
    for (let i = 0; i < confirmPositions.length; i++) {
      if (confirmInputs[i].trim() !== words[confirmPositions[i]]) {
        return setError("Mnemonic verification failed — please check your backup");
      }
    }
    await finalize(mnemonic);
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) return setError("Passwords do not match");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    // Normalize whitespace: algosdk splits by single space only, so newlines or
    // multiple spaces between words (common when pasting from wallet backups) cause
    // a false "invalid mnemonic" error without this step.
    const normalized = importMnemonic.trim().split(/\s+/).join(" ");
    try {
      algosdk.mnemonicToSecretKey(normalized);
    } catch {
      return setError("Invalid mnemonic — enter all 25 Algorand words, space-separated");
    }
    await finalize(normalized);
  }

  // Mnemonic wallet init
  async function finalize(mn: string) {
    setLoading(true);
    try {
      await sendBg({ type: "WALLET_INIT", password, mnemonic: mn });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  }

  // ── WalletConnect path ───────────────────────────────────────────────────

  async function handleWcPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirmPassword) return setError("Passwords do not match");
    if (password.length < 8) return setError("Password must be at least 8 characters");
    setLoading(true);
    try {
      // Init an empty vault — no mnemonic account
      await sendBg({ type: "WALLET_INIT", password, mnemonic: null });
      setStep("wc_connect");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  }

  function handleWcConnected(_account: Account) {
    // Vault is already initialised; WC account was saved by WC_ADD_ACCOUNT
    onComplete();
  }

  return (
    <div className="flex flex-col min-h-[560px] p-5">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 bg-algo rounded-lg flex items-center justify-center text-black font-bold">
          AV
        </div>
        <div>
          <h1 className="text-lg font-bold leading-none">AlgoVoi</h1>
          <p className="text-xs text-gray-400">Algorand · Voi · x402</p>
        </div>
      </div>

      {/* ── Step: choice ── */}
      {step === "choice" && (
        <div className="flex flex-col gap-4 flex-1 justify-center">
          <h2 className="text-xl font-semibold text-center mb-2">Welcome</h2>
          <p className="text-sm text-gray-400 text-center mb-4">
            How would you like to set up AlgoVoi?
          </p>
          <button className="btn-primary w-full py-3" onClick={startCreate}>
            Create New Wallet
          </button>
          <button className="btn-secondary w-full py-3" onClick={() => setStep("import")}>
            Import with Mnemonic
          </button>

          {/* Divider */}
          <div className="flex items-center gap-3 my-1">
            <div className="flex-1 h-px bg-white/10" />
            <span className="text-xs text-gray-500">or</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          <button
            className="w-full py-3 rounded-xl border border-algo/40 text-algo text-sm font-semibold
              hover:bg-algo/10 transition-colors flex items-center justify-center gap-2"
            onClick={() => { setPassword(""); setConfirmPassword(""); setError(""); setStep("wc_password"); }}
          >
            <span className="text-base">📱</span>
            Connect Mobile Wallet
            <span className="text-xs font-normal text-gray-400">(Pera · Defly · Lute)</span>
          </button>
        </div>
      )}

      {/* ── Step: create (set password) ── */}
      {step === "create" && (
        <form onSubmit={handleCreate} className="flex flex-col gap-4 flex-1">
          <h2 className="text-lg font-semibold">Set Password</h2>
          <p className="text-sm text-gray-400">
            Your password encrypts your keys locally. It cannot be recovered.
          </p>
          <input
            type="password"
            className="input"
            placeholder="Password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            className="input"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-2 mt-auto">
            <button type="button" className="btn-secondary flex-1" onClick={() => setStep("choice")}>
              Back
            </button>
            <button type="submit" className="btn-primary flex-1">
              Continue
            </button>
          </div>
        </form>
      )}

      {/* ── Step: backup mnemonic ── */}
      {step === "backup" && (
        <div className="flex flex-col gap-4 flex-1">
          <h2 className="text-lg font-semibold">Back Up Your Mnemonic</h2>
          <p className="text-sm text-yellow-400">
            Write these 25 words down. This is the only way to recover your wallet.
          </p>
          <div className="grid grid-cols-5 gap-1.5 bg-surface-2 rounded-xl p-3">
            {mnemonic.split(" ").map((word, i) => (
              <div key={i} className="text-center">
                <span className="text-gray-500 text-[10px] block">{i + 1}</span>
                <span className="text-xs font-mono text-white">{word}</span>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            Never share this with anyone. AlgoVoi will never ask for it.
          </p>
          <button className="btn-primary w-full mt-auto" onClick={handleBackupConfirm}>
            I've Written It Down
          </button>
        </div>
      )}

      {/* ── Step: confirm mnemonic backup ── */}
      {step === "confirm" && (
        <form onSubmit={handleConfirm} className="flex flex-col gap-4 flex-1">
          <h2 className="text-lg font-semibold">Verify Backup</h2>
          <p className="text-sm text-gray-400">
            Enter the words at the positions shown to confirm your backup.
          </p>
          <div className="space-y-3">
            {confirmPositions.map((pos, i) => (
              <div key={pos}>
                <label className="block text-xs text-gray-400 mb-1">
                  Word #{pos + 1}
                </label>
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={confirmInputs[i]}
                  onChange={(e) => {
                    const next = [...confirmInputs];
                    next[i] = e.target.value;
                    setConfirmInputs(next);
                  }}
                  autoFocus={i === 0}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2
                             text-sm font-mono focus:outline-none focus:border-blue-500"
                />
              </div>
            ))}
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-2 mt-auto">
            <button type="button" className="btn-secondary flex-1" onClick={() => setStep("backup")}>
              Back
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={loading}>
              {loading ? "Creating…" : "Create Wallet"}
            </button>
          </div>
        </form>
      )}

      {/* ── Step: import mnemonic ── */}
      {step === "import" && (
        <form onSubmit={handleImport} className="flex flex-col gap-4 flex-1">
          <h2 className="text-lg font-semibold">Import Wallet</h2>
          <textarea
            className="input h-24 resize-none font-mono text-sm"
            placeholder="Enter your 25-word mnemonic phrase…"
            value={importMnemonic}
            onChange={(e) => setImportMnemonic(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            className="input"
            placeholder="New password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <input
            type="password"
            className="input"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-2 mt-auto">
            <button type="button" className="btn-secondary flex-1" onClick={() => setStep("choice")}>
              Back
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={loading}>
              {loading ? "Importing…" : "Import Wallet"}
            </button>
          </div>
        </form>
      )}

      {/* ── Step: WC — set password ── */}
      {step === "wc_password" && (
        <form onSubmit={handleWcPassword} className="flex flex-col gap-4 flex-1">
          <h2 className="text-lg font-semibold">Set a Password</h2>
          <p className="text-sm text-gray-400">
            Choose a password to protect AlgoVoi. Your private keys stay on your phone.
          </p>
          <input
            type="password"
            className="input"
            placeholder="Password (min 8 chars)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            className="input"
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-2 mt-auto">
            <button type="button" className="btn-secondary flex-1" onClick={() => setStep("choice")}>
              Back
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={loading}>
              {loading ? "Setting up…" : "Continue"}
            </button>
          </div>
        </form>
      )}

      {/* ── Step: WC — QR modal ── */}
      {/* Vault is already initialised at this point. Whether the user connects
          or dismisses, forward to AccountView — they can click + Connect there. */}
      {step === "wc_connect" && (
        <WalletConnectModal
          onConnected={handleWcConnected}
          onClose={onComplete}
        />
      )}
    </div>
  );
}
