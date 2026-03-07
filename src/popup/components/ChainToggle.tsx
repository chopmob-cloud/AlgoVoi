import { sendBg } from "../App";
import type { ChainId } from "@shared/types/chain";

interface Props {
  activeChain: ChainId;
  onChange: (chain: ChainId) => void;
}

export default function ChainToggle({ activeChain, onChange }: Props) {
  async function switchChain(chain: ChainId) {
    if (chain === activeChain) return;
    onChange(chain); // optimistic
    try {
      await sendBg({ type: "WALLET_SET_CHAIN", chain });
    } catch (err) {
      onChange(activeChain); // revert on error
      console.error("Failed to switch chain:", err);
    }
  }

  return (
    <div className="flex bg-surface-2 rounded-lg p-0.5 gap-0.5">
      <button
        className={`flex-1 text-xs font-semibold py-1.5 rounded-md transition-colors ${
          activeChain === "algorand"
            ? "bg-algo text-black"
            : "text-gray-400 hover:text-white"
        }`}
        onClick={() => switchChain("algorand")}
      >
        Algorand
      </button>
      <button
        className={`flex-1 text-xs font-semibold py-1.5 rounded-md transition-colors ${
          activeChain === "voi"
            ? "bg-voi text-white"
            : "text-gray-400 hover:text-white"
        }`}
        onClick={() => switchChain("voi")}
      >
        Voi
      </button>
    </div>
  );
}
