import PopupShell from './PopupShell'

export default function X402Screen() {
  return (
    <section id="x402" className="py-24 px-6 bg-surf1/30 relative overflow-hidden">
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', left: '-80px', top: '80px' }} />
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', right: '-80px', top: '120px' }} />

      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row-reverse items-center gap-16 relative z-10">
        {/* Tagline */}
        <div className="flex-1 max-w-md">
          <h2 className="text-4xl font-black leading-tight mb-4">
            Automatic<br />
            <span className="gradient-text-rev">x402 payments</span>
          </h2>
          <p className="text-gray leading-relaxed mb-6">
            AlgoVoi intercepts HTTP 402 responses and handles micropayments invisibly —
            no copy-paste, no manual steps. Just browse and pay.
          </p>
          <div className="flex flex-wrap gap-2">
            {['⚡ Sub-second payments', '🛡️ Spending caps', '🔁 Auto-retry fetch'].map(p => (
              <span key={p} className="bg-surf1 border border-border rounded-full px-3 py-1 text-xs text-gray">{p}</span>
            ))}
          </div>
        </div>

        {/* x402 approval mockup */}
        <PopupShell width="w-[400px]">
          {/* Header */}
          <div className="flex items-center gap-2.5 px-5 pt-5 pb-0">
            <div className="w-9 h-9 rounded-[10px] flex items-center justify-center text-sm"
              style={{ background: 'linear-gradient(135deg,#8B5CF6,#00C8FF)' }}>
              ⚡
            </div>
            <div>
              <div className="text-sm font-bold">Payment Required</div>
              <div className="text-[10px] text-gray mt-0.5">x402 · Voi Mainnet</div>
            </div>
          </div>

          <div className="px-5 py-4">
            {/* Site */}
            <div className="bg-surf1 rounded-[10px] px-3.5 py-2.5 mb-3 border border-border">
              <div className="text-[10px] text-gray mb-0.5">Requesting site</div>
              <div className="text-sm font-semibold">x402.ilovechicken.co.uk</div>
              <div className="text-[10px] text-gray mt-0.5">/api/content/premium-article</div>
            </div>

            {/* Amount */}
            <div className="rounded-xl p-4 mb-3 text-center border"
              style={{ background: 'linear-gradient(135deg,#8B5CF611,#00C8FF11)', borderColor: '#8B5CF633' }}>
              <div className="text-[10px] text-gray mb-1">Payment amount</div>
              <div className="text-3xl font-black gradient-text-rev">1.00 VOI</div>
              <div className="text-[10px] text-gray mt-1">≈ $0.003 USD</div>
            </div>

            {/* Details */}
            <div className="space-y-1.5 mb-1">
              {[
                { label: 'From',         value: 'VPAB…7G3K', mono: true },
                { label: 'Network',      value: 'Voi Mainnet' },
                { label: 'Protocol',     value: 'x402 / exact' },
                { label: 'Spending cap', value: '10 VOI remaining', color: '#00C8FF' },
              ].map(r => (
                <div key={r.label} className="flex justify-between text-xs text-gray">
                  <span>{r.label}</span>
                  <span className={`font-semibold text-text ${r.mono ? 'font-mono' : ''}`}
                    style={r.color ? { color: r.color } : {}}>
                    {r.value}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Buttons */}
          <div className="flex gap-2.5 px-5 pb-5">
            <button className="flex-1 py-2.5 rounded-xl bg-surf2 border border-border text-sm font-bold text-text">
              Reject
            </button>
            <button className="flex-1 py-2.5 rounded-xl gradient-btn text-sm font-bold text-[#0D1117]">
              Approve &amp; Pay
            </button>
          </div>
        </PopupShell>
      </div>
    </section>
  )
}
