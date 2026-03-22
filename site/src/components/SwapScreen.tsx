import PopupShell from './PopupShell'

export default function SwapScreen() {
  return (
    <section id="swap" className="py-24 px-6 bg-surf1/30 relative overflow-hidden">
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', right: '-100px', top: '50px' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', left: '-100px', top: '150px' }} />

      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row items-center gap-16 relative z-10">
        {/* Tagline */}
        <div className="flex-1 max-w-md">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-algo animate-pulse" />
            Haystack Router · Best-route aggregation
          </div>
          <h2 className="text-4xl font-black leading-tight mb-4">
            DEX swaps across<br />
            <span className="gradient-text">every Algorand DEX</span>
          </h2>
          <p className="text-gray leading-relaxed mb-6">
            Swap any Algorand ASA directly inside the extension. Haystack Router finds the
            best price across all Algorand DEXes — Tinyman, Pact, Humble, and more.
            Works with both mnemonic wallets and WalletConnect.
          </p>
          <div className="flex flex-wrap gap-2 mb-8">
            {['🌐 All Algorand DEXes', '📱 WalletConnect', '⚡ Best route auto-selected', '💱 ALGO · USDC · USDt · any ASA'].map(p => (
              <span key={p} className="bg-surf1 border border-border rounded-full px-3 py-1 text-xs text-gray">{p}</span>
            ))}
          </div>

          {/* Route aggregation diagram */}
          <div className="bg-surf1 border border-border rounded-2xl p-4 text-xs">
            <div className="text-[10px] text-gray mb-3 font-semibold uppercase tracking-wide">Route aggregation</div>
            <div className="flex items-center gap-2">
              {/* From */}
              <div className="flex flex-col items-center gap-1 flex-shrink-0">
                <div className="w-8 h-8 rounded-full flex items-center justify-center font-black text-sm"
                  style={{ background: '#00C8FF22', color: '#00C8FF' }}>Ⓐ</div>
                <span className="text-[9px] text-gray">ALGO</span>
              </div>

              {/* Routes */}
              <div className="flex-1 flex flex-col gap-1 min-w-0">
                {[
                  { dex: 'Tinyman', pct: '60%', color: '#00C8FF' },
                  { dex: 'Pact',    pct: '30%', color: '#8B5CF6' },
                  { dex: 'Humble',  pct: '10%', color: '#34D399' },
                ].map(r => (
                  <div key={r.dex} className="flex items-center gap-1.5">
                    <div className="h-px flex-1" style={{ background: r.color, opacity: 0.5 }} />
                    <span className="text-[9px] font-semibold flex-shrink-0" style={{ color: r.color }}>
                      {r.dex} {r.pct}
                    </span>
                    <div className="h-px flex-1" style={{ background: r.color, opacity: 0.5 }} />
                  </div>
                ))}
              </div>

              {/* To */}
              <div className="flex flex-col items-center gap-1 flex-shrink-0">
                <div className="w-8 h-8 rounded-full flex items-center justify-center font-black text-sm"
                  style={{ background: '#2775CA22', color: '#2775CA' }}>$</div>
                <span className="text-[9px] text-gray">USDC</span>
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-border flex justify-between">
              <span className="text-muted">Best split saves</span>
              <span className="text-green-400 font-semibold">≈ 0.12% vs single route</span>
            </div>
          </div>
        </div>

        {/* Swap panel mockup */}
        <PopupShell>
          {/* Wallet header */}
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg gradient-btn flex items-center justify-center text-[10px] font-black text-[#0D1117]">AV</div>
              <span className="text-sm font-bold">AlgoVoi</span>
            </div>
            <span className="text-gray text-xs">Lock</span>
          </div>

          {/* Account card */}
          <div className="mx-4 mb-3 rounded-xl px-4 py-3" style={{ background: 'linear-gradient(135deg,#00C8FF11,#161B22)', border: '1px solid #00C8FF22' }}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] text-gray font-mono">ABC4…XY12</div>
                <div className="text-xl font-black text-text mt-0.5">142.50 <span className="text-sm text-gray font-normal">ALGO</span></div>
              </div>
              <div className="flex gap-1.5">
                <div className="bg-white/10 rounded-lg px-2.5 py-1 text-[10px] font-semibold text-text">Send</div>
                <div className="bg-white/10 rounded-lg px-2.5 py-1 text-[10px] font-semibold text-text">Receive</div>
              </div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex px-4 gap-1 border-b border-surf2 mb-3">
            <div className="px-3 py-1.5 text-xs font-semibold text-muted">Assets</div>
            <div className="px-3 py-1.5 text-xs font-semibold text-muted">History</div>
            <div className="px-3 py-1.5 text-xs font-semibold text-white border-b-2 border-algo rounded-t">Swap</div>
            <div className="px-3 py-1.5 text-xs font-semibold text-muted">Agents</div>
          </div>

          {/* Swap form */}
          <div className="px-4 pb-4 flex flex-col gap-2.5">
            {/* From */}
            <div className="bg-surf1 rounded-xl p-3 border border-border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-gray">From</span>
                <span className="text-[10px] text-gray">Balance: 142.50</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="bg-surf2 rounded-lg px-2 py-1 text-[10px] font-semibold text-text flex-shrink-0 border border-border">ALGO</div>
                <div className="flex-1 text-right text-sm font-semibold text-text">10.00</div>
              </div>
            </div>

            {/* Swap direction */}
            <div className="flex justify-center -my-1">
              <div className="w-6 h-6 rounded-full bg-surf2 border border-border flex items-center justify-center text-muted text-xs">⇅</div>
            </div>

            {/* To */}
            <div className="bg-surf1 rounded-xl p-3 border border-border">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] text-gray">To</span>
                <span className="text-[10px] text-algo font-semibold">≈ 1.4521 USDC</span>
              </div>
              <div className="bg-surf2 rounded-lg px-2 py-1 text-[10px] font-semibold text-text inline-block border border-border">USDC</div>
            </div>

            {/* Quote details */}
            <div className="bg-surf1 rounded-xl px-3 py-2.5 border border-border flex flex-col gap-1.5 text-[10px]">
              {[
                { label: 'You receive',   value: '1.4521 USDC',  color: '#fff' },
                { label: 'Price impact',  value: '0.08%',        color: '#34D399' },
                { label: 'USD value',     value: '$1.45',        color: '#aaa' },
                { label: 'Routes',        value: '3',            color: '#aaa' },
              ].map(r => (
                <div key={r.label} className="flex justify-between">
                  <span className="text-gray">{r.label}</span>
                  <span className="font-semibold" style={{ color: r.color }}>{r.value}</span>
                </div>
              ))}
            </div>

            {/* Slippage */}
            <div className="flex items-center justify-between px-0.5">
              <span className="text-[10px] text-gray">Slippage tolerance</span>
              <div className="flex items-center gap-1">
                <div className="bg-surf1 border border-border rounded px-2 py-0.5 text-[10px] text-text font-semibold w-10 text-right">0.5</div>
                <span className="text-[10px] text-gray">%</span>
              </div>
            </div>

            {/* Buttons */}
            <div className="flex gap-2">
              <button className="flex-1 py-2 rounded-xl bg-surf2 border border-border text-[10px] font-semibold text-gray">
                Get Quote
              </button>
              <button className="flex-1 py-2 rounded-xl gradient-btn text-[10px] font-bold text-[#0D1117]">
                Swap
              </button>
            </div>

            <p className="text-[9px] text-muted text-center">Powered by Haystack Router</p>
          </div>
        </PopupShell>
      </div>
    </section>
  )
}
