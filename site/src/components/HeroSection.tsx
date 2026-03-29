export default function HeroSection() {
  return (
    <section className="min-h-screen flex flex-col items-center justify-center text-center px-6 pt-20 relative overflow-hidden">
      {/* Glows */}
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', left: '-100px', top: '100px' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', right: '-100px', top: '200px' }} />

      <div className="relative z-10 max-w-3xl">
        <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-algo animate-pulse" />
          Now available on Chrome &amp; Firefox
        </div>

        <h1 className="text-5xl md:text-7xl font-black leading-tight mb-6">
          Web3 wallet for<br />
          <span className="gradient-text">Algorand &amp; Voi</span>
        </h1>

        <p className="text-lg text-gray max-w-xl mx-auto mb-8 leading-relaxed">
          Non-custodial browser extension for Chrome and Firefox. Send tokens, swap on both chains, connect AI agents
          via WalletConnect, handle x402, MPP &amp; AP2 payments — all automatic. Built for humans and AI agents alike.
        </p>

        <div className="flex flex-wrap justify-center gap-2 mb-10">
          {['🔒 Non-custodial', '⚡ x402 · MPP · AP2', '💱 Algorand + Voi swaps', '🤖 AI Agent Wallet', '💳 Buy crypto', '📱 WalletConnect', '🔗 ARC-0027'].map(p => (
            <span key={p} className="bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray">{p}</span>
          ))}
        </div>

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
            href="https://github.com/chopmob-cloud/AlgoVoi"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-surf1 border border-border text-text font-bold px-8 py-3 rounded-xl text-sm hover:bg-surf2 transition-colors"
          >
            View on GitHub
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
