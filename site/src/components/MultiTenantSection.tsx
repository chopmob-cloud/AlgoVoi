export default function MultiTenantSection() {
  const features = [
    {
      icon: '🔑',
      title: 'One tenant API key',
      desc: 'Register once, get an API key. Point the AlgoVoi gateway at your resource definitions — no chain nodes or facilitator servers to run.',
    },
    {
      icon: '🏗️',
      title: 'Hard tenant isolation',
      desc: 'Every tenant is fully isolated at the database level using row-level security. Your payments, receipts, and API keys never touch another tenant.',
    },
    {
      icon: '⛓️',
      title: 'Algorand & Voi native',
      desc: 'Accept payments on Algorand or Voi mainnet. Multi-chain accepts[] are served automatically — one resource definition covers both networks.',
    },
    {
      icon: '🤖',
      title: 'Browser & agent ready',
      desc: 'Human users pay via the AlgoVoi extension. AI agents parse 402 challenges and retry programmatically — identical backend, same flow.',
    },
    {
      icon: '🛡️',
      title: 'Security-first, fail-closed',
      desc: 'Kill switch, amount caps, test/live network separation, KYB gate, and a 10-layer security model — enforced at the gateway, not just documented.',
    },
    {
      icon: '📊',
      title: 'Full audit trail',
      desc: 'Every challenge, verification, limit change, and key event is logged per tenant with typed event codes and no PII in log lines.',
    },
  ]

  const onboarding = [
    { step: '1', label: 'Create tenant', sub: 'POST /tenants via control plane' },
    { arrow: true },
    { step: '2', label: 'Complete KYB', sub: 'Submit company details' },
    { arrow: true },
    { step: '3', label: 'Test on testnet', sub: 'Full x402 flow, no real money' },
    { arrow: true },
    { step: '4', label: 'KYB approved', sub: 'Compliance review passes' },
    { arrow: true },
    { step: '5', label: 'Activate live', sub: 'POST activate-live → mainnet' },
  ]

  const paymentFlow = [
    { step: '1', label: 'Request resource', sub: 'with tenant API key' },
    { arrow: true },
    { step: '2', label: 'Gateway returns 402', sub: 'PAYMENT-REQUIRED header' },
    { arrow: true },
    { step: '3', label: 'Client pays on-chain', sub: 'Algorand or Voi' },
    { arrow: true },
    { step: '4', label: 'Retry with proof', sub: 'PAYMENT-SIGNATURE header' },
    { arrow: true },
    { step: '5', label: 'Receipt issued', sub: 'payment lands at payout addr' },
  ]

  return (
    <section id="platform" className="py-24 px-6 relative overflow-hidden">
      {/* Background glows */}
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF0D,transparent 70%)', left: '-100px', top: '0' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF60D,transparent 70%)', right: '-100px', bottom: '0' }} />

      <div className="max-w-6xl mx-auto relative z-10">
        {/* Heading */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            Live — x402 Tenant Platform
          </div>
          <h2 className="text-4xl md:text-5xl font-black leading-tight mb-4">
            x402 payments<br />
            <span className="gradient-text">as a service</span>
          </h2>
          <p className="text-gray max-w-xl mx-auto leading-relaxed">
            AlgoVoi is a hosted multi-tenant x402 paywall platform.
            Your business gets private, isolated payment infrastructure without running
            your own chain nodes, servers, or verification facilitators.
          </p>
        </div>

        {/* Tenant onboarding flow */}
        <div className="mb-6">
          <div className="text-xs text-gray text-center mb-4 uppercase tracking-widest">Tenant onboarding</div>
          <div className="grid grid-cols-1 sm:grid-cols-9 gap-2 items-center max-w-4xl mx-auto">
            {onboarding.map((item, i) =>
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
        </div>

        {/* Payment flow */}
        <div className="mb-16">
          <div className="text-xs text-gray text-center mb-4 uppercase tracking-widest">Payment flow</div>
          <div className="grid grid-cols-1 sm:grid-cols-9 gap-2 items-center max-w-4xl mx-auto">
            {paymentFlow.map((item, i) =>
              'arrow' in item ? (
                <div key={i} className="hidden sm:flex justify-center text-muted text-xl">→</div>
              ) : (
                <div key={i} className="bg-surf1/60 border border-border/60 rounded-xl p-3 text-center">
                  <div className="w-7 h-7 rounded-full border border-algo/40 flex items-center justify-center text-xs font-black text-algo mx-auto mb-2">
                    {item.step}
                  </div>
                  <div className="text-xs font-semibold text-text leading-tight">{item.label}</div>
                  <div className="text-[10px] text-gray mt-0.5">{item.sub}</div>
                </div>
              )
            )}
          </div>
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

        {/* Two-panel code snippet: onboarding + payment */}
        <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-4 mb-14">
          {/* Tenant setup */}
          <div className="bg-surf1 border border-border rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surf2">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              <span className="text-[11px] text-gray ml-2">1. Register your tenant</span>
            </div>
            <pre className="text-xs leading-relaxed p-4 overflow-x-auto text-text font-mono">
{`# Control plane — create tenant
POST https://cp.ilovechicken.co.uk/tenants
Authorization: Bearer <admin-key>

{
  "display_name": "Acme Payments Ltd",
  "networks": ["algorand_mainnet"],
  "payout_addresses": {
    "algorand_mainnet": "AAAA…ZZZZ"
  }
}

# → 201  { "id": "uuid", "short_id": "acme-x4f2",
#           "mode": "test", "kyb_status": "pending" }

# Issue a tenant API key
POST /tenants/{id}/apikeys
# → { "key": "ak_live_…" }  ← shown once only`}
            </pre>
          </div>

          {/* Payment flow */}
          <div className="bg-surf1 border border-border rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surf2">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              <span className="text-[11px] text-gray ml-2">2. Start accepting x402 payments</span>
            </div>
            <pre className="text-xs leading-relaxed p-4 overflow-x-auto text-text font-mono">
{`# Gateway — request a protected resource
GET https://api1.ilovechicken.co.uk/x402/challenge
Authorization: Bearer <tenant-api-key>

# → 402  PAYMENT-REQUIRED: base64({
#   "accepts": [{
#     "network": "algorand_mainnet",
#     "payTo": "AAAA…ZZZZ",
#     "maxAmountRequired": "1000000",
#     "asset": "0"
#   }]
# })

# Pay on-chain, retry with signed proof
PAYMENT-SIGNATURE: base64({
  "scheme": "exact",
  "network": "algorand_mainnet",
  "payload": { "txId": "ABC…", "payer": "XYZ…" }
})
# → 200  { "receipt": { … } }
# Payment lands instantly at payout_address`}
            </pre>
          </div>
        </div>

        {/* Mode & compliance callout */}
        <div className="max-w-4xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-4 mb-14">
          <div className="bg-surf1 border border-border rounded-2xl p-5">
            <div className="text-lg mb-2">🧪</div>
            <div className="text-sm font-bold text-text mb-1">Test mode first</div>
            <div className="text-xs text-gray leading-relaxed">
              All tenants start in test mode on testnet — full x402 flow, no real money.
              Identical API surface, zero code change when you go live.
            </div>
          </div>
          <div className="bg-surf1 border border-border rounded-2xl p-5">
            <div className="text-lg mb-2">✅</div>
            <div className="text-sm font-bold text-text mb-1">KYB required for live</div>
            <div className="text-xs text-gray leading-relaxed">
              UK-regulated B2B platform. Submit your company details; once KYB is approved,
              an operator activates live mode — no shortcut.
            </div>
          </div>
          <div className="bg-surf1 border border-border rounded-2xl p-5">
            <div className="text-lg mb-2">⚡</div>
            <div className="text-sm font-bold text-text mb-1">Instant settlement</div>
            <div className="text-xs text-gray leading-relaxed">
              Payments land directly at your payout address on-chain. No platform float,
              no settlement delay — what clears is yours immediately.
            </div>
          </div>
        </div>

        {/* CTA */}
        <div className="text-center mt-4">
          <p className="text-gray text-sm mb-4">Ready to start accepting x402 payments?</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="https://api1.ilovechicken.co.uk/dashboard/signup"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block gradient-btn text-[#0D1117] font-bold px-8 py-3 rounded-xl text-sm"
            >
              Request access
            </a>
            <a
              href="https://api1.ilovechicken.co.uk/dashboard/login"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block bg-surf1 border border-border text-text font-bold px-8 py-3 rounded-xl text-sm hover:bg-surf2 transition-colors"
            >
              Operator login
            </a>
            <a
              href="https://x.com/AlgoVoi"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block bg-surf1 border border-border text-text font-bold px-8 py-3 rounded-xl text-sm hover:bg-surf2 transition-colors"
            >
              Get in touch on X
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
