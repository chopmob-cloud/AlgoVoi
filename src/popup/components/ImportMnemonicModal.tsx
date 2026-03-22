/**
 * ImportMnemonicModal — import a 25-word mnemonic as a time-limited local signing key.
 *
 * The mnemonic is stored encrypted in the vault with a 30-day TTL.
 * After 30 days the key is auto-wiped and the user must re-import.
 * This eliminates WalletConnect from all signing paths.
 */

import { useState } from "react";
import algosdk from "algosdk";
import { sendBg } from "../App";
import type { Account } from "@shared/types/wallet";

interface Props {
  onImported: (account: Account) => void;
  onCancel: () => void;
}

export default function ImportMnemonicModal({ onImported, onCancel }: Props) {
  const [mnemonic, setMnemonic] = useState("");
  const [name, setName]         = useState("");
  const [error, setError]       = useState("");
  const [importing, setImporting] = useState(false);

  function validate(): string | null {
    const words = mnemonic.trim().split(/\s+/);
    if (words.length !== 25) return `Expected 25 words, got ${words.length}`;
    try {
      algosdk.mnemonicToSecretKey(mnemonic.trim());
    } catch {
      return "Invalid mnemonic — check your words and try again";
    }
    return null;
  }

  async function handleImport() {
    const err = validate();
    if (err) { setError(err); return; }

    setImporting(true);
    setError("");
    try {
      const { account } = await sendBg<{ account: Account }>({
        type: "WALLET_IMPORT_TIMED",
        name: name.trim() || "Local Key",
        mnemonic: mnemonic.trim(),
        ttlDays: 30,
      });
      onImported(account);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
      setImporting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-[#0D1117] border border-white/10 rounded-2xl w-full max-w-sm p-5 space-y-4">
        <div>
          <h2 className="text-lg font-bold">Import local signing key</h2>
          <p className="text-xs text-gray-400 mt-1">
            Enter your 25-word mnemonic. It will be stored encrypted for 30 days,
            then automatically wiped. All operations sign locally — no phone needed.
          </p>
        </div>

        <div>
          <label className="text-[10px] text-gray-500 block mb-1">Account name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Main Wallet"
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-[#00C8FF]/50"
          />
        </div>

        <div>
          <label className="text-[10px] text-gray-500 block mb-1">25-word mnemonic</label>
          <textarea
            value={mnemonic}
            onChange={(e) => { setMnemonic(e.target.value); setError(""); }}
            placeholder="word1 word2 word3 ... word25"
            rows={4}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-gray-600 focus:outline-none focus:border-[#00C8FF]/50 resize-none font-mono"
          />
        </div>

        <div className="bg-blue-900/20 border border-blue-700/30 rounded-lg px-3 py-2 space-y-1">
          <div className="flex items-center gap-1.5 text-[10px] text-blue-300 font-semibold">
            🔒 Security
          </div>
          <ul className="text-[10px] text-gray-400 space-y-0.5">
            <li>• Encrypted with AES-GCM-256 (same as vault)</li>
            <li>• Auto-wiped after 30 days — re-import to refresh</li>
            <li>• Never sent to any server or relay</li>
            <li>• Signs swaps, sends, and payments locally</li>
          </ul>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-lg px-3 py-2">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={importing}
            className="flex-1 py-2 rounded-xl bg-white/5 border border-white/10 text-xs font-semibold text-gray-400 hover:text-white disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={importing || !mnemonic.trim()}
            className="flex-1 py-2 rounded-xl bg-gradient-to-r from-[#00C8FF] to-[#8B5CF6] text-xs font-bold text-[#0D1117] disabled:opacity-40"
          >
            {importing ? "Importing…" : "Import (30 days)"}
          </button>
        </div>
      </div>
    </div>
  );
}
