import PopupShell from './PopupShell'

export default function WalletScreen() {
  return (
    <section id="wallet" className="py-24 px-6 relative overflow-hidden">
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', left: '-80px', top: '50px' }} />
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', right: '-80px', top: '100px' }} />

      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row items-center gap-16 relative z-10">
        {/* Tagline */}
        <div className="flex-1 max-w-md">
          <h2 className="text-4xl font-black leading-tight mb-4">
            Web3 wallet for<br />
            <span className="gradient-text">Algorand &amp; Voi</span>
          </h2>
          <p className="text-gray leading-relaxed mb-6">
            Send tokens, sign transactions, and handle x402, MPP &amp; AP2 payments automatically.
            Supports AI agent signing via WalletConnect. Manage both chains from one sleek extension.
          </p>
          <div className="flex flex-wrap gap-2">
            {['🔒 Non-custodial', '⚡ x402 · MPP · AP2', '🤖 AI agents', '📱 WalletConnect', '🔗 ARC-0027'].map(p => (
              <span key={p} className="bg-surf1 border border-border rounded-full px-3 py-1 text-xs text-gray">{p}</span>
            ))}
          </div>
        </div>

        {/* Popup mockup */}
        <PopupShell>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg gradient-btn flex items-center justify-center text-[10px] font-black text-[#0D1117]">AV</div>
              <span className="text-sm font-bold">AlgoVoi</span>
            </div>
            <div className="flex gap-4 items-center">
              <span className="text-algo text-xs font-semibold">+ Connect</span>
              <span className="text-gray text-xs">Lock</span>
            </div>
          </div>

          {/* Chain toggle */}
          <div className="mx-4 mb-2.5 flex bg-surf1 rounded-[10px] p-[3px]">
            <div className="flex-1 py-1.5 rounded-lg text-xs font-semibold text-center text-algo"
              style={{ background: '#00C8FF22', border: '1px solid #00C8FF44' }}>
              Algorand
            </div>
            <div className="flex-1 py-1.5 rounded-lg text-xs font-semibold text-center text-muted">Voi</div>
          </div>

          {/* Account card */}
          <div className="mx-4 mb-3 rounded-xl p-4" style={{ background: 'linear-gradient(135deg,#00C8FF11,#161B22)', border: '1px solid #00C8FF22' }}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-[11px] text-gray mb-1">Main Wallet</div>
                <div className="text-[11px] text-gray font-mono">ABC4…XY12 ⎘</div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-black text-text leading-none">142.50</div>
                <div className="text-xs text-gray mt-0.5">ALGO</div>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="flex-1 bg-white/10 rounded-lg py-1.5 text-xs font-semibold text-center text-text">Send</div>
              <div className="flex-1 bg-white/10 rounded-lg py-1.5 text-xs font-semibold text-center text-text">Receive</div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex px-4 gap-1 border-b border-surf2 mb-2.5">
            <div className="px-3 py-1.5 text-xs font-semibold text-white border-b-2 border-algo rounded-t">Assets</div>
            <div className="px-3 py-1.5 text-xs font-semibold text-muted">History</div>
            <div className="px-3 py-1.5 text-xs font-semibold text-muted">Apps</div>
          </div>

          {/* Asset list */}
          <div className="pb-2">
            {[
              { icon: 'Ⓐ', iconBg: '#00C8FF22', iconColor: '#00C8FF', name: 'Algorand', sub: 'ALGO · native', bal: '142.50', balColor: '#00C8FF', usd: '$21.38' },
              { icon: '$',  iconBg: '#2775CA22', iconColor: '#2775CA', name: 'USD Coin', sub: 'USDC · #31566704', bal: '50.00', balColor: '#2775CA', usd: '$50.00' },
              { icon: '◈',  iconBg: '#FF6B3522', iconColor: '#FF6B35', name: 'Folks rALGO', sub: 'rALGO · #1138500612', bal: '100.00', balColor: '#FF6B35', usd: '' },
            ].map(a => (
              <div key={a.name} className="flex items-center justify-between px-4 py-2 border-b border-surf2/30 last:border-0">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-black flex-shrink-0"
                    style={{ background: a.iconBg, color: a.iconColor }}>{a.icon}</div>
                  <div>
                    <div className="text-sm font-semibold text-text">{a.name}</div>
                    <div className="text-[10px] text-gray">{a.sub}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold" style={{ color: a.balColor }}>{a.bal}</div>
                  {a.usd && <div className="text-[10px] text-gray">{a.usd}</div>}
                </div>
              </div>
            ))}
          </div>
        </PopupShell>
      </div>
    </section>
  )
}
