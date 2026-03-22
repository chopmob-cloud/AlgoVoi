import PopupShell from './PopupShell'

export default function SendScreen() {
  return (
    <section id="send" className="py-24 px-6 bg-surf1/30 relative overflow-hidden">
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', right: '-80px', top: '50px' }} />

      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row-reverse items-center gap-16 relative z-10">
        {/* Tagline */}
        <div className="flex-1 max-w-md">
          <h2 className="text-4xl font-black leading-tight mb-4">
            Send any<br />
            <span className="gradient-text">token or ASA</span>
          </h2>
          <p className="text-gray leading-relaxed mb-6">
            Native coins and ASA tokens in one unified send flow, on both Algorand and Voi.
            Resolve .voi names instead of pasting long addresses.
          </p>
          <div className="flex flex-wrap gap-2">
            {['🌐 enVoi name resolution', '🔢 BigInt-safe amounts', '📋 Optional memo'].map(p => (
              <span key={p} className="bg-surf1 border border-border rounded-full px-3 py-1 text-xs text-gray">{p}</span>
            ))}
          </div>
        </div>

        {/* Send modal mockup */}
        <PopupShell>
          <div className="m-4 bg-surf1 rounded-2xl p-5 border border-border">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold">Send USDC</h3>
              <span className="text-muted text-xl leading-none">×</span>
            </div>

            <label className="text-[11px] text-gray mb-1 block">Asset</label>
            <div className="bg-surf2 rounded-[10px] px-3 py-2 text-xs text-text mb-3 border border-border">
              USD Coin (USDC) · #31566704
            </div>

            <label className="text-[11px] text-gray mb-1 block">
              Recipient <span className="text-muted">or .voi name</span>
            </label>
            <div className="bg-surf2 rounded-[10px] px-3 py-2 text-xs text-gray font-mono mb-3 border border-border">
              RECV…ADDR
            </div>

            <label className="text-[11px] text-gray mb-1 block">
              Amount <span className="text-muted">(available: 50.00 USDC)</span>
            </label>
            <div className="relative mb-3">
              <div className="bg-surf2 rounded-[10px] px-3 py-2 text-xs text-text border border-border">25.00</div>
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-algo font-bold">MAX</span>
            </div>

            <label className="text-[11px] text-gray mb-1 block">Note (optional)</label>
            <div className="bg-surf2 rounded-[10px] px-3 py-2 text-xs text-gray mb-4 border border-border">
              Coffee ☕
            </div>

            <div className="gradient-btn rounded-xl py-2.5 text-center text-sm font-bold text-[#0D1117]">
              Send USDC
            </div>
          </div>
        </PopupShell>
      </div>
    </section>
  )
}
