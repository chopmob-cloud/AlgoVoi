import { useState, useRef, useEffect } from "react";
import type { ChainId } from "../../shared/types/chain";

function sendBg<T = unknown>(msg: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res: { ok: boolean; data: T; error?: string }) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.ok) resolve(res.data);
      else reject(new Error(res?.error ?? "Unknown error"));
    });
  });
}

type Category = "tokens" | "nfts" | "swaps" | "names" | "lending" | "general";

interface CategoryDef { id: Category; label: string; emoji: string; hints: string[] }

const VOI_CATEGORIES: CategoryDef[] = [
  { id: "tokens", label: "Tokens", emoji: "\u{1FA99}", hints: [
    "List tokens", "Check balance", "Token holders", "Transfer history", "Build transfer",
  ]},
  { id: "nfts", label: "NFTs", emoji: "\u{1F5BC}", hints: [
    "Browse collections", "My NFTs", "Transfer history", "Marketplace listings", "Recent sales",
  ]},
  { id: "swaps", label: "Swaps", emoji: "\u{1F504}", hints: [
    "Get swap quote", "Pool details", "Token prices", "Price history", "Find arbitrage", "Swap routes",
  ]},
  { id: "names", label: "Names", emoji: "\u{1F30D}", hints: [
    "Resolve .voi name", "Lookup address", "Search names", "Register a name",
  ]},
  { id: "lending", label: "Lending", emoji: "\u{1F3E6}", hints: [
    "Lending markets", "Market rates & APY", "My health factor", "My positions", "Liquidatable users",
  ]},
  { id: "general", label: "General", emoji: "\u{2699}", hints: [
    "Send payment", "Bridge to Algorand", "Submit transaction",
  ]},
];

const ALGORAND_CATEGORIES: CategoryDef[] = [
  { id: "tokens", label: "Tokens", emoji: "\u{1FA99}", hints: [
    "Search ALGO assets", "Asset verification", "Asset details", "Check balance",
  ]},
  { id: "swaps", label: "Swaps", emoji: "\u{1F504}", hints: [
    "Get Haystack quote", "Swap ALGO for USDC", "Check opt-in", "Best swap route",
  ]},
  { id: "names", label: "Names", emoji: "\u{1F30D}", hints: [
    "Lookup NFD", "Search NFDs", "Browse NFDs for sale", "NFD analytics",
  ]},
  { id: "general", label: "General", emoji: "\u{2699}", hints: [
    "Send payment", "Submit transaction",
  ]},
];

interface PendingTxn {
  tool: string;
  network: string;
  txns: string[];
  action: string;
  sender?: string;
  receiver?: string;
  amount?: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  pendingTxns?: PendingTxn[];
}

export default function AgentChat({
  activeAddress,
  balance,
  chain,
  onActiveChange,
}: {
  activeAddress: string;
  balance?: string;
  chain: ChainId;
  onActiveChange?: (active: boolean) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [signing, setSigning] = useState(false);
  const [category, setCategory] = useState<Category>("general");
  const [expanded, setExpanded] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const CATEGORIES = chain === "algorand" ? ALGORAND_CATEGORIES : VOI_CATEGORIES;
  const placeholder = chain === "algorand" ? "Ask about Algorand..." : "Ask about Voi...";
  const accentBg = chain === "algorand" ? "bg-algo/30" : "bg-voi/30";
  const accentBorder = chain === "algorand" ? "border-algo/50" : "border-voi/50";
  const accentBtn = chain === "algorand" ? "bg-algo hover:bg-algo/80" : "bg-voi hover:bg-voi/80";
  const bubbleBg = chain === "algorand" ? "bg-algo/20" : "bg-voi/20";

  const isActive = expanded || messages.length > 0 || loading;

  // Clear chat on wallet/chain switch — prevents cross-account and cross-chain leakage
  const prevAddress = useRef(activeAddress);
  const prevChain = useRef(chain);
  useEffect(() => {
    if (prevAddress.current !== activeAddress || prevChain.current !== chain) {
      setMessages([]);
      setInput("");
      setCategory("general");
      setLoading(false);
      setSigning(false);
      prevAddress.current = activeAddress;
      prevChain.current = chain;
    }
  }, [activeAddress, chain]);

  useEffect(() => {
    onActiveChange?.(isActive);
  }, [isActive, onActiveChange]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    setExpanded(true);
    const userMsg: ChatMessage = { role: "user", content: text };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput("");
    setLoading(true);

    try {
      const sendMessages = updated.slice(-20).map((m) => ({ role: m.role, content: m.content }));
      const result = await sendBg<{ reply: string; pendingTxns?: PendingTxn[] }>({
        type: "AGENT_CHAT",
        messages: sendMessages,
        activeAddress,
        balance,
        category,
        chain,
      });
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: result.reply,
        pendingTxns: result.pendingTxns,
      }]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err instanceof Error ? err.message : "Something went wrong"}` },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSignAll(pendingTxns: PendingTxn[], msgIndex: number) {
    setSigning(true);
    try {
      // Merge all pending txns into a single sign + submit flow.
      // AVM swaps often produce multiple tool calls (approve + swap + withdraw)
      // which the server returns as separate PendingTxn objects. We combine
      // all txns into one group so the user signs once.
      // Pre-sign check: if any txn group was built for a different address,
      // the background XXII-1 check will reject it — catch early with a clear message.
      const mismatch = pendingTxns.find((t) => t.sender && t.sender !== activeAddress);
      if (mismatch) {
        throw new Error(
          `These transactions were built for ${mismatch.sender!.slice(0, 8)}… — switch to that account first, or ask again.`
        );
      }

      const allTxns = pendingTxns.flatMap((t) => t.txns);
      const network = pendingTxns[0].network;

      const signResult = await sendBg<{ signedTxns: string[] }>({
        type: "SIGN_AGENT_TRANSACTIONS",
        txns: allTxns,
        network,
      });

      const submitResult = await sendBg<{ txId: string }>({
        type: "SUBMIT_TRANSACTIONS",
        signedTxns: signResult.signedTxns,
        network,
      });

      setMessages((prev) => prev.map((m, i) =>
        i === msgIndex
          ? { ...m, content: m.content + `\n\nTransaction submitted! TxID: ${submitResult.txId}`, pendingTxns: undefined }
          : m
      ));
    } catch (err) {
      setMessages((prev) => prev.map((m, i) =>
        i === msgIndex
          ? { ...m, content: m.content + `\n\nSigning failed: ${err instanceof Error ? err.message : "Unknown error"}` }
          : m
      ));
    } finally {
      setSigning(false);
    }
  }

  function handleClose() {
    setMessages([]);
    setExpanded(false);
    setInput("");
  }

  // Full-screen takeover when active
  if (isActive) {
    return (
      <div className="flex flex-col h-full min-h-0">
        {/* Category buttons — top, two rows centered */}
        <div className="flex flex-col items-center gap-1 px-3 pt-1 pb-2 shrink-0 relative">
          <button
            onClick={handleClose}
            className="absolute right-3 top-1 text-gray-500 hover:text-white text-[10px] px-1.5 py-0.5 rounded transition-colors"
            title="Close chat"
          >
            ✕
          </button>
          <div className="flex flex-wrap gap-1 justify-center">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className={`text-[10px] px-2 py-1 rounded-lg whitespace-nowrap transition-colors ${
                  category === c.id
                    ? `${accentBg} text-white border ${accentBorder}`
                    : "bg-surface-2 text-gray-400 border border-transparent hover:text-white"
                }`}
              >
                {c.emoji} {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* Quick action hints */}
        {messages.length === 0 && !loading && (
          <div className="flex flex-wrap gap-1 px-3 pb-2 justify-center shrink-0">
            {CATEGORIES.find((c) => c.id === category)?.hints.map((hint) => (
              <button
                key={hint}
                onClick={() => { setInput(hint); }}
                className="text-[9px] px-2 py-0.5 rounded-full bg-surface-2 text-gray-400 hover:text-white hover:bg-white/10 transition-colors border border-white/5"
              >
                {hint}
              </button>
            ))}
          </div>
        )}

        {/* Messages — fills all available space */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 space-y-2 min-h-0">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-xl px-2.5 py-1.5 text-xs leading-relaxed ${
                  msg.role === "user" ? `${bubbleBg} text-white` : "bg-surface-2 text-gray-200"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                {msg.pendingTxns && msg.pendingTxns.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1">
                    {msg.pendingTxns.map((txn, ti) => (
                      <div key={ti} className="bg-black/20 rounded-lg px-2 py-1.5">
                        <div className="text-[9px] text-gray-400 space-y-0.5">
                          <div><span className="text-gray-500">Action:</span> {txn.action}</div>
                          {txn.receiver && <div><span className="text-gray-500">To:</span> {txn.receiver.slice(0, 8)}…{txn.receiver.slice(-4)}</div>}
                          {txn.amount && <div><span className="text-gray-500">Amount:</span> {txn.amount}</div>}
                          <div><span className="text-gray-500">Txns:</span> {txn.txns.length}</div>
                        </div>
                      </div>
                    ))}
                    <div className="text-[9px] text-yellow-600/80 text-center">⚠ Review before signing</div>
                    <button
                      onClick={() => handleSignAll(msg.pendingTxns!, i)}
                      disabled={signing}
                      className={`w-full ${accentBtn} text-white text-[10px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-40 transition-colors`}
                    >
                      {signing ? "Signing..." : `Sign & Send (${msg.pendingTxns.reduce((n, t) => n + t.txns.length, 0)} txns)`}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {loading && (
            <div className="flex justify-start">
              <div className="bg-surface-2 rounded-xl px-3 py-2 text-xs text-gray-400">
                <span className="animate-pulse">Thinking...</span>
              </div>
            </div>
          )}
        </div>

        {/* Input — pinned to bottom */}
        <div className="px-3 py-2 border-t border-surface-2 shrink-0">
          <div className="flex gap-1.5">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              disabled={loading}
              rows={1}
              className="flex-1 bg-surface-2 border border-surface-2 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 resize-none focus:outline-none focus:border-gray-500 disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className={`${accentBtn} text-white text-xs px-3 rounded-lg disabled:opacity-40 transition-colors`}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Compact idle state
  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Category buttons — top, two rows centered */}
      <div className="flex flex-col items-center gap-1 px-3 pt-1 pb-2 shrink-0 relative">
        <button
          onClick={handleClose}
          className="absolute right-3 top-1 text-gray-500 hover:text-white text-[10px] px-1.5 py-0.5 rounded transition-colors"
          title="Close chat"
        >
          ✕
        </button>
        <div className="flex gap-1 justify-center">
          {CATEGORIES.filter((c) => !["lending", "general"].includes(c.id)).map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`text-[10px] px-2 py-1 rounded-lg whitespace-nowrap transition-colors ${
                category === c.id
                  ? "bg-voi/30 text-white border border-voi/50"
                  : "bg-surface-2 text-gray-400 border border-transparent hover:text-white"
              }`}
            >
              {c.emoji} {c.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 justify-center">
          {CATEGORIES.filter((c) => ["lending", "general"].includes(c.id)).map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`text-[10px] px-2 py-1 rounded-lg whitespace-nowrap transition-colors ${
                category === c.id
                  ? "bg-voi/30 text-white border border-voi/50"
                  : "bg-surface-2 text-gray-400 border border-transparent hover:text-white"
              }`}
            >
              {c.emoji} {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Quick action hints */}
      <div className="flex flex-wrap gap-1 px-3 pb-2 justify-center">
        {CATEGORIES.find((c) => c.id === category)?.hints.map((hint) => (
          <button
            key={hint}
            onClick={() => { setInput(hint); }}
            className="text-[9px] px-2 py-0.5 rounded-full bg-surface-2 text-gray-400 hover:text-white hover:bg-white/10 transition-colors border border-white/5"
          >
            {hint}
          </button>
        ))}
      </div>

      {/* Empty state fills remaining space */}
      <div className="flex-1 flex items-center justify-center">
        <p className="text-[10px] text-gray-600 text-center">
          Tap a hint or type your question
        </p>
      </div>

      {/* Input */}
      <div className="px-3 py-2 border-t border-surface-2">
        <div className="flex gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={loading}
            rows={1}
            className="flex-1 bg-surface-2 border border-surface-2 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 resize-none focus:outline-none focus:border-gray-500 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="bg-voi hover:bg-voi/80 text-white text-xs px-3 rounded-lg disabled:opacity-40 transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
