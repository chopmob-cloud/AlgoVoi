import PopupShell from './PopupShell'

export default function BuyScreen() {
  return (
    <section id="buy" className="py-24 px-6 relative overflow-hidden">
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', right: '-100px', top: '50px' }} />

      <div className="max-w-6xl mx-auto relative z-10">
        <div className="flex flex-col lg:flex-row items-center gap-16">

          {/* Text */}
          <div className="flex-1 max-w-lg">
            <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
              <span className="w-1.5 h-1.5 rounded-full bg-algo animate-pulse" />
              Coinbase Onramp
            </div>
            <h2 className="text-4xl md:text-5xl font-black leading-tight mb-4">
              Buy crypto<br />
              <span className="gradient-text">in the wallet</span>
            </h2>
            <p className="text-gray leading-relaxed mb-6">
              Purchase ALGO directly from the Assets tab via Coinbase Onramp.
              No external exchanges, no copy-pasting addresses. Funds arrive
              straight into your wallet.
            </p>
            <div className="space-y-3">
              {[
                { icon: '🔐', text: 'Secure session tokens — wallet address never in URL parameters' },
                { icon: '⚡', text: 'One-click flow — Buy button right on the Assets tab' },
                { icon: '🌍', text: 'Expanding availability — more regions coming soon' },
              ].map(f => (
                <div key={f.text} className="flex items-start gap-3">
                  <span className="text-lg">{f.icon}</span>
                  <span className="text-sm text-gray">{f.text}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Mockup */}
          <PopupShell width="w-[320px]">
            <div className="px-4 pt-4 pb-2 flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-algo/20 flex items-center justify-center text-xs font-bold text-algo">AV</div>
              <div>
                <div className="text-xs font-bold">Main Wallet</div>
                <div className="text-[10px] text-gray font-mono">ABCD…7G3K</div>
              </div>
              <div className="ml-auto text-[10px] text-algo font-semibold border border-algo/40 bg-algo/10 rounded px-1.5 py-0.5">
                Algorand
              </div>
            </div>

            <div className="px-4 py-3">
              <div className="text-center mb-4">
                <div className="text-2xl font-black">142.50 ALGO</div>
                <div className="text-xs text-gray">$28.50 USD</div>
              </div>

              <div className="flex gap-2 mb-4">
                <button className="flex-1 py-2 rounded-xl bg-surf2 border border-border text-xs font-bold text-text">
                  Send
                </button>
                <button className="flex-1 py-2 rounded-xl bg-surf2 border border-border text-xs font-bold text-text">
                  Receive
                </button>
                <button className="flex-1 py-2 rounded-xl gradient-btn text-xs font-bold text-[#0D1117]">
                  Buy
                </button>
              </div>

              <div className="bg-algo/10 border border-algo/20 rounded-xl p-3 text-center">
                <div className="text-xs text-algo font-semibold mb-1">Coinbase Onramp</div>
                <div className="text-[10px] text-gray">
                  Purchase ALGO with card or bank transfer.
                  Funds deposited directly to your wallet address.
                </div>
              </div>
            </div>
          </PopupShell>
        </div>
      </div>
    </section>
  )
}
