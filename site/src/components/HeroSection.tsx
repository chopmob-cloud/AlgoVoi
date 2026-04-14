export default function HeroSection() {
  const chains = [
    { name: 'Algorand', color: '#00C8FF', dot: 'bg-algo' },
    { name: 'Voi',      color: '#8B5CF6', dot: 'bg-voi' },
    { name: 'Hedera',   color: '#10b981', dot: 'bg-emerald-400' },
    { name: 'Stellar',  color: '#7C63D0', dot: 'bg-[#7C63D0]' },
  ]

  return (
    <section className="min-h-screen flex flex-col items-center justify-center text-center px-6 pt-20 relative overflow-hidden">
      {/* Glows */}
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', left: '-100px', top: '100px' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', right: '-100px', top: '200px' }} />
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#10b98110,transparent 70%)', left: '30%', bottom: '80px' }} />

      <div className="relative z-10 max-w-4xl w-full">
        {/* Badge */}
        <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-algo animate-pulse" />
          Now available on Chrome &amp; Firefox
        </div>

        {/* Main headline — wallet identity */}
        <h1 className="text-4xl sm:text-5xl md:text-7xl font-black leading-tight mb-3">
          Web3 wallet for<br />
          <span className="gradient-text">Algorand &amp; Voi</span>
        </h1>

        {/* eCommerce identity */}
        <div className="flex items-center justify-center gap-2 flex-wrap mb-6">
          <span className="text-gray text-sm sm:text-base font-medium">+</span>
          <span className="text-sm sm:text-base font-bold text-text">eCommerce payments across</span>
          {chains.map((c, i) => (
            <span key={c.name} className="inline-flex items-center gap-1.5 text-sm sm:text-base font-bold"
              style={{ color: c.color }}>
              {i > 0 && <span className="text-border font-normal">·</span>}
              <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
              {c.name}
            </span>
          ))}
        </div>

        <p className="text-base sm:text-lg text-gray max-w-2xl mx-auto mb-8 leading-relaxed">
          Non-custodial browser extension with built-in eCommerce adapters for WooCommerce, OpenCart,
          PrestaShop &amp; Shopware. Handle x402, MPP &amp; AP2 machine payments automatically.
          Built for humans and AI agents alike.
        </p>

        {/* Feature pills */}
        <div className="flex flex-wrap justify-center gap-2 mb-10">
          {[
            '🔒 Non-custodial wallet',
            '🛒 eCommerce on 4 chains',
            '⚡ x402 · MPP · AP2',
            '💱 Algorand + Voi swaps',
            '🤖 AI Agent Wallet',
            '📱 WalletConnect',
            '🔗 ARC-0027',
          ].map(p => (
            <span key={p} className="bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray">{p}</span>
          ))}
        </div>

        {/* Chain row */}
        <div className="flex flex-wrap items-center justify-center gap-3 mb-10">
          {chains.map(c => (
            <div key={c.name} className="flex items-center gap-1.5 bg-surf1 border border-border rounded-full px-3 py-1.5 text-xs font-semibold"
              style={{ color: c.color }}>
              <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
              {c.name}
            </div>
          ))}
        </div>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href="https://chromewebstore.google.com/detail/algovoi/ofmgegnkjdmbeakjbmfaagigmhagdcbl"
            target="_blank"
            rel="noopener noreferrer"
            className="gradient-btn text-[#0D1117] font-bold px-8 py-3 rounded-xl text-sm"
          >
            Add to Chrome — Free
          </a>
          <a
            href="https://addons.mozilla.org/en-GB/firefox/addon/algovoi/"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-surf1 border border-border text-text font-bold px-8 py-3 rounded-xl text-sm hover:bg-surf2 transition-colors"
          >
            Add to Firefox — Free
          </a>
          <a
            href="https://api1.ilovechicken.co.uk/signup"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-surf1 border border-emerald-400/30 text-emerald-400 font-bold px-8 py-3 rounded-xl text-sm hover:bg-surf2 transition-colors"
          >
            Start eCommerce Trial →
          </a>
        </div>
      </div>

      {/* Scroll hint */}
      <div className="absolute bottom-8 flex flex-col items-center gap-1 text-muted text-xs">
        <span>Scroll to explore</span>
        <span className="animate-bounce">↓</span>
      </div>
    </section>
  )
}
