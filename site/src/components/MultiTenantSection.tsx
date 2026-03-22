export default function MultiTenantSection() {
  const features = [
    {
      icon: '🔑',
      title: 'One API key',
      desc: 'Register once. Get a key. Point your clients at AlgoVoi endpoints — no server setup required.',
    },
    {
      icon: '🏗️',
      title: 'Hard tenant isolation',
      desc: 'Every tenant lives in its own isolated environment. Your data, receipts, and access grants never touch another tenant\'s.',
    },
    {
      icon: '⛓️',
      title: 'Algorand & Voi native',
      desc: 'Accept payments on Algorand or Voi mainnet. Multi-chain accepts[] served automatically per protected resource.',
    },
    {
      icon: '🤖',
      title: 'Browser & agent ready',
      desc: 'Human users pay via the AlgoVoi extension. API agents parse 402 challenges and retry programmatically — same backend.',
    },
    {
      icon: '🛡️',
      title: 'Security-first, fail-closed',
      desc: 'Replay protection, Argon2id key hashing, SERIALIZABLE receipts, and an internal-only verification facilitator.',
    },
    {
      icon: '📊',
      title: 'Full audit trail',
      desc: 'Every challenge, proof attempt, grant, and rate-limit event is logged per tenant — typed codes, no PII.',
    },
  ]

  return (
    <section id="multitenant" className="py-24 px-6 relative overflow-hidden">
      {/* Background glows */}
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF0D,transparent 70%)', left: '-100px', top: '0' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF60D,transparent 70%)', right: '-100px', bottom: '0' }} />

      <div className="max-w-6xl mx-auto relative z-10">
        {/* Heading */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-voi" />
            Coming soon — x402 Paywall Platform
          </div>
          <h2 className="text-4xl md:text-5xl font-black leading-tight mb-4">
            x402 payments<br />
            <span className="gradient-text">as a service</span>
          </h2>
          <p className="text-gray max-w-xl mx-auto leading-relaxed">
            AlgoVoi is becoming a hosted multi-tenant x402 paywall platform.
            Companies get a private, isolated payment infrastructure without running
            their own chain nodes, servers, or facilitators.
          </p>
        </div>

        {/* How it works flow */}
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-center mb-16 max-w-4xl mx-auto">
          {[
            { step: '1', label: 'Client sends request', sub: 'with API key' },
            { arrow: true },
            { step: '2', label: 'AlgoVoi returns 402', sub: 'with payment challenge' },
            { arrow: true },
            { step: '3', label: 'Client pays on-chain', sub: 'Algorand or Voi' },
            { arrow: true },
            { step: '4', label: 'Retries with proof', sub: 'txId header' },
            { arrow: true },
            { step: '5', label: 'Access token issued', sub: 'signed, short-lived' },
          ].map((item, i) =>
            'arrow' in item ? (
              <div key={i} className="hidden sm:flex justify-center text-muted text-xl">→</div>
            ) : (
              <div key={i} className="bg-surf1 border border-border rounded-xl p-3 text-center">
                <div className="w-7 h-7 gradient-btn rounded-full flex items-center justify-center text-xs font-black text-[#0D1117] mx-auto mb-2">
                  {item.step}
                </div>
                <div className="text-xs font-semibold text-text leading-tight">{item.label}</div>
                <div className="text-[10px] text-gray mt-0.5">{item.sub}</div>
              </div>
            )
          )}
        </div>

        {/* Feature grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-14">
          {features.map(f => (
            <div key={f.title} className="bg-surf1 border border-border rounded-2xl p-5 hover:border-algo/40 transition-colors">
              <div className="text-2xl mb-3">{f.icon}</div>
              <div className="text-sm font-bold text-text mb-1.5">{f.title}</div>
              <div className="text-xs text-gray leading-relaxed">{f.desc}</div>
            </div>
          ))}
        </div>

        {/* Tenant integration snippet */}
        <div className="max-w-3xl mx-auto bg-surf1 border border-border rounded-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surf2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            <span className="text-[11px] text-gray ml-2">Tenant integration — as simple as it gets</span>
          </div>
          <pre className="text-xs leading-relaxed p-5 overflow-x-auto text-text font-mono">
{`# .env — the only config your tenant needs
ALGOVOU_API_KEY=algovou_a3f9c2b1_<your-secret>
ALGOVOU_GATEWAY=https://pay.algovou.com

# Send a request — receive a 402 if unpaid
GET /v1/resource/premium-content-01
Authorization: Bearer $ALGOVOU_API_KEY

# → 402 Payment Required
# { "accepts": [{ "network": "algorand-mainnet", "payTo": "...", ... }] }

# Pay on-chain, retry with proof
GET /v1/resource/premium-content-01
Authorization: Bearer $ALGOVOU_API_KEY
X-Payment: { "network": "algorand-mainnet", "txId": "...", "requirementId": "..." }

# → 200 OK  { "accessToken": "eyJ..." }`}
          </pre>
        </div>

        {/* CTA */}
        <div className="text-center mt-12">
          <p className="text-gray text-sm mb-4">Want early access to the multi-tenant platform?</p>
          <a
            href="https://x.com/AlgoVoi"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block gradient-btn text-[#0D1117] font-bold px-8 py-3 rounded-xl text-sm"
          >
            Follow for updates on X
          </a>
        </div>
      </div>
    </section>
  )
}
