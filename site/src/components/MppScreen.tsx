import PopupShell from './PopupShell'

export default function MppScreen() {
  return (
    <section id="mpp" className="py-24 px-6 bg-surf1/30 relative overflow-hidden">
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', left: '-80px', top: '80px' }} />
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', right: '-80px', top: '120px' }} />

      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row items-center gap-16 relative z-10">
        {/* Tagline */}
        <div className="flex-1 max-w-md">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-3 py-1 text-[11px] text-gray mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-algo animate-pulse" />
            paymentauth.org · mpp.dev
          </div>
          <h2 className="text-4xl font-black leading-tight mb-4">
            Machine Payments<br />
            <span className="gradient-text">Protocol (MPP)</span>
          </h2>
          <p className="text-gray leading-relaxed mb-6">
            MPP is an open standard for machine-readable payment challenges over HTTP.
            AlgoVoi intercepts <code className="text-algo text-xs bg-surf2 px-1.5 py-0.5 rounded">WWW-Authenticate: Payment</code> headers,
            builds and signs an AVM transaction, then injects the resulting
            <code className="text-algo text-xs bg-surf2 px-1.5 py-0.5 rounded ml-1">Authorization: Payment</code> credential
            for seamless retry — no manual steps.
          </p>
          <div className="flex flex-wrap gap-2">
            {['🤖 Machine-readable', '⛓️ AVM on-chain proof', '🔁 Auto-retry', '🛡️ Spending caps'].map(p => (
              <span key={p} className="bg-surf1 border border-border rounded-full px-3 py-1 text-xs text-gray">{p}</span>
            ))}
          </div>
        </div>

        {/* MPP approval popup mockup */}
        <PopupShell width="w-[400px]">
          {/* Header */}
          <div className="flex items-center gap-2.5 px-5 pt-5 pb-0">
            <div className="w-9 h-9 rounded-[10px] flex items-center justify-center text-sm"
              style={{ background: 'linear-gradient(135deg,#00C8FF,#8B5CF6)' }}>
              🤖
            </div>
            <div>
              <div className="text-sm font-bold">MPP Charge Request</div>
              <div className="text-[10px] text-gray mt-0.5">Machine Payments Protocol · Algorand</div>
            </div>
          </div>

          <div className="px-5 py-4">
            {/* Site */}
            <div className="bg-surf1 rounded-[10px] px-3.5 py-2.5 mb-3 border border-border">
              <div className="text-[10px] text-gray mb-0.5">Requesting server</div>
              <div className="text-sm font-semibold">api.example.com</div>
              <div className="text-[10px] text-gray mt-0.5">realm="Premium API Access"</div>
            </div>

            {/* Amount */}
            <div className="rounded-xl p-4 mb-3 text-center border"
              style={{ background: 'linear-gradient(135deg,#00C8FF11,#8B5CF611)', borderColor: '#00C8FF33' }}>
              <div className="text-[10px] text-gray mb-1">Charge amount</div>
              <div className="text-3xl font-black gradient-text">0.50 ALGO</div>
              <div className="text-[10px] text-gray mt-1">≈ $0.001 USD</div>
            </div>

            {/* Details */}
            <div className="space-y-1.5 mb-1">
              {[
                { label: 'From',         value: 'ABC4…XY12', mono: true },
                { label: 'Method',       value: 'avm / intent=charge' },
                { label: 'Network',      value: 'Algorand Mainnet' },
                { label: 'Spending cap', value: '5 ALGO remaining', color: '#00C8FF' },
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
