import PopupShell from './PopupShell'

export default function VoiWalletScreen() {
  return (
    <section id="walletconnect" className="py-24 px-6 relative overflow-hidden">
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', left: '-80px', top: '50px' }} />
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', right: '-80px', top: '100px' }} />

      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row items-center gap-16 relative z-10">
        {/* Tagline */}
        <div className="flex-1 max-w-md">
          <h2 className="text-4xl font-black leading-tight mb-4">
            Connect your<br />
            <span className="gradient-text-rev">mobile wallet</span>
          </h2>
          <p className="text-gray leading-relaxed mb-6">
            Pair Pera, Defly, or Voi Wallet via WalletConnect. Chain-aware sessions —
            Algorand and Voi stay separate so you never sign on the wrong network.
          </p>
          <div className="flex flex-wrap gap-2">
            {['📱 Pera Wallet', '📱 Defly', '📱 Voi Wallet'].map(p => (
              <span key={p} className="bg-surf1 border border-border rounded-full px-3 py-1 text-xs text-gray">{p}</span>
            ))}
          </div>
        </div>

        {/* VOI wallet mockup */}
        <PopupShell>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3.5">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg gradient-btn flex items-center justify-center text-[10px] font-black text-[#0D1117]">AV</div>
              <span className="text-sm font-bold">AlgoVoi</span>
            </div>
            <div className="flex gap-4 items-center">
              <span className="text-voi text-xs font-semibold">+ Connect</span>
              <span className="text-gray text-xs">Lock</span>
            </div>
          </div>

          {/* Chain toggle — VOI active */}
          <div className="mx-4 mb-2.5 flex bg-surf1 rounded-[10px] p-[3px]">
            <div className="flex-1 py-1.5 rounded-lg text-xs font-semibold text-center text-muted">Algorand</div>
            <div className="flex-1 py-1.5 rounded-lg text-xs font-semibold text-center text-voi"
              style={{ background: '#8B5CF622', border: '1px solid #8B5CF644' }}>
              Voi
            </div>
          </div>

          {/* VOI Account card */}
          <div className="mx-4 mb-3 rounded-xl p-4" style={{ background: 'linear-gradient(135deg,#8B5CF611,#161B22)', border: '1px solid #8B5CF622' }}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="flex items-center gap-1.5 text-[11px] text-gray mb-1">
                  Voi Mobile
                  <span className="text-[9px] text-voi border border-voi/40 bg-voi/10 rounded px-1 py-px">Voi Wallet · Voi</span>
                </div>
                <div className="text-[11px] text-gray font-mono">VPAB…7G3K ⎘</div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-black text-text leading-none">88.12</div>
                <div className="text-xs text-gray mt-0.5">VOI</div>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="flex-1 bg-white/10 rounded-lg py-1.5 text-xs font-semibold text-center text-text">Send</div>
              <div className="flex-1 bg-white/10 rounded-lg py-1.5 text-xs font-semibold text-center text-text">Receive</div>
            </div>
          </div>

          {/* Tabs */}
          <div className="flex px-4 gap-1 border-b border-surf2 mb-2.5">
            <div className="px-3 py-1.5 text-xs font-semibold text-white border-b-2 border-voi rounded-t">Assets</div>
            <div className="px-3 py-1.5 text-xs font-semibold text-muted">History</div>
            <div className="px-3 py-1.5 text-xs font-semibold text-muted">Apps</div>
          </div>

          {/* VOI Assets */}
          <div className="pb-2">
            {[
              { icon: '◈', iconBg: '#8B5CF622', iconColor: '#8B5CF6', name: 'Voi', sub: 'VOI · native', bal: '88.12', balColor: '#8B5CF6' },
              { icon: '$', iconBg: '#2775CA22', iconColor: '#2775CA', name: 'Arcpay USDC', sub: 'aUSDC · #302190', bal: '120.00', balColor: '#2775CA' },
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
                <div className="text-sm font-semibold" style={{ color: a.balColor }}>{a.bal}</div>
              </div>
            ))}
          </div>
        </PopupShell>
      </div>
    </section>
  )
}
