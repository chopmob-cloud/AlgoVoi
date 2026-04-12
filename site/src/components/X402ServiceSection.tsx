export default function X402ServiceSection() {
  const steps = [
    {
      n: '1',
      title: 'Register your resource',
      desc: 'Sign up with your Algorand or Voi wallet. Set a price, payout address, and resource URL. No email needed.',
    },
    {
      n: '2',
      title: 'Gate your API endpoint',
      desc: 'Add a single middleware call. On unpaid requests, return the PAYMENT-REQUIRED header — we build it for you.',
    },
    {
      n: '3',
      title: 'AlgoVoi pays automatically',
      desc: 'The browser extension intercepts the 402, signs an on-chain transaction, and retries the request — invisible to the user.',
    },
    {
      n: '4',
      title: 'Settlement confirmed',
      desc: 'Our hosted facilitator verifies the on-chain txId and calls your /settle webhook. Funds land in your wallet.',
    },
  ]

  const features = [
    { icon: '🌐', title: 'Hosted facilitator', desc: 'No chain nodes, no indexer — we verify on-chain settlement and call your webhook.' },
    { icon: '⚡', title: 'Sub-second settlement', desc: 'Transaction confirmed on Algorand or Voi, indexed, and webhook fired in under 5 seconds.' },
    { icon: '🔑', title: 'Wallet-only auth', desc: 'Register and manage resources with your crypto wallet. No passwords, no OAuth.' },
    { icon: '🛡️', title: 'Spending cap enforcement', desc: 'Per-user caps enforced client-side by AlgoVoi. Users can never be overcharged.' },
    { icon: '📦', title: 'Drop-in middleware', desc: 'Python, Go, PHP, Rust, and Node.js helpers. Add to any framework in under 10 lines.' },
    { icon: '💸', title: 'Any price, any asset', desc: 'Charge fractions of a cent for AI inference, $1 for articles, or $100 for data exports.' },
  ]

  const codeSnippet = `# Python — gate any Flask route with x402
from algovou_x402 import require_payment

@app.route("/api/data")
@require_payment(
    price="1000000",   # 1 VOI in microunits
    asset="0",         # native coin
    network="voi-mainnet",
    pay_to="YOUR_VOI_ADDRESS",
)
def premium_data():
    return jsonify({"data": "..."})`

  return (
    <section id="x402-service" className="py-24 px-6 relative overflow-hidden">
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', right: '-100px', top: '80px' }} />
      <div className="absolute w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF10,transparent 70%)', left: '-80px', bottom: '100px' }} />

      <div className="max-w-6xl mx-auto relative z-10">
        {/* Heading */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-voi animate-pulse" />
            Hosted x402 Facilitator
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-black leading-tight mb-4">
            x402 as a service —<br />
            <span className="gradient-text-rev">monetise any API in minutes</span>
          </h2>
          <p className="text-gray max-w-2xl mx-auto leading-relaxed text-sm sm:text-base">
            Gate any HTTP endpoint behind a crypto micropayment. AlgoVoi hosts the x402 facilitator,
            verifies on-chain settlement, and fires your webhook — you just add middleware.
            No chain nodes. No indexer. No infrastructure.
          </p>
        </div>

        {/* Steps */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-16">
          {steps.map((s, i) => (
            <div key={s.n} className="bg-surf1 border border-border rounded-2xl p-5 relative">
              {i < steps.length - 1 && (
                <div className="hidden lg:block absolute -right-2.5 top-8 text-muted text-sm z-10">→</div>
              )}
              <div className="w-8 h-8 rounded-full border border-voi/40 flex items-center justify-center text-xs font-black text-voi mb-3">
                {s.n}
              </div>
              <div className="text-sm font-bold text-text mb-1.5">{s.title}</div>
              <div className="text-xs text-gray leading-relaxed">{s.desc}</div>
            </div>
          ))}
        </div>

        {/* Code + features */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-16 items-start">
          {/* Code snippet */}
          <div className="bg-surf1 border border-border rounded-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex gap-1.5">
                <span className="w-3 h-3 rounded-full bg-red-500/60" />
                <span className="w-3 h-3 rounded-full bg-yellow-500/60" />
                <span className="w-3 h-3 rounded-full bg-green-500/60" />
              </div>
              <span className="text-[11px] text-gray font-mono">x402_example.py</span>
              <span className="text-[10px] text-voi bg-voi/10 border border-voi/20 rounded px-2 py-0.5">10 lines</span>
            </div>
            <pre className="text-[11px] sm:text-xs text-gray leading-relaxed p-5 overflow-x-auto font-mono whitespace-pre">
{codeSnippet}
            </pre>
          </div>

          {/* Feature grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {features.map(f => (
              <div key={f.title} className="bg-surf1 border border-border rounded-2xl p-4 hover:border-voi/30 transition-colors">
                <div className="text-xl mb-2">{f.icon}</div>
                <div className="text-xs font-bold text-text mb-1">{f.title}</div>
                <div className="text-[11px] text-gray leading-relaxed">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Use cases */}
        <div className="mb-16">
          <div className="text-xs text-gray text-center mb-5 uppercase tracking-widest">Use cases</div>
          <div className="flex flex-wrap justify-center gap-3">
            {[
              '🤖 AI inference APIs',
              '📰 Premium content',
              '📊 Data exports',
              '🗺️ Geocoding & maps',
              '🔍 Search APIs',
              '💬 LLM completions',
              '📈 Market data feeds',
              '🎮 Game asset APIs',
            ].map(u => (
              <span key={u} className="bg-surf1 border border-border rounded-full px-4 py-2 text-xs text-gray hover:border-voi/30 hover:text-text transition-colors">
                {u}
              </span>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="bg-gradient-to-r from-voi/10 via-algo/10 to-voi/10 border border-voi/20 rounded-2xl p-6 sm:p-8 text-center">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-3 py-1 text-[11px] text-gray mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-voi animate-pulse" />
            Free 60-day trial · 0.5% fee after
          </div>
          <h3 className="text-xl sm:text-2xl font-black text-text mb-2">
            Start charging for your API in 30 seconds
          </h3>
          <p className="text-sm text-gray mb-6 max-w-lg mx-auto">
            Register a resource, drop in the middleware, and you're live. AlgoVoi users pay automatically — no wallets to integrate, no SDKs to ship.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="https://api1.ilovechicken.co.uk/signup"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block gradient-btn text-[#0D1117] font-bold px-8 py-3.5 rounded-xl text-sm"
            >
              Register a Resource →
            </a>
            <a
              href="https://github.com/coinbase/x402"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block bg-surf1 border border-border text-text font-bold px-8 py-3.5 rounded-xl text-sm hover:bg-surf2 transition-colors"
            >
              x402 Spec on GitHub
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
