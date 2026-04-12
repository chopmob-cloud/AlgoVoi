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
      title: 'Algorand, VOI, Hedera & Stellar',
      desc: 'Accept payments on Algorand, VOI, Hedera, or Stellar mainnet. Multi-chain checkout with chain picker — customers choose their preferred network.',
    },
    {
      icon: '🤖',
      title: 'Browser & agent ready',
      desc: 'Human users pay via the AlgoVoi extension. AI agents parse 402 challenges and retry programmatically — identical backend, same flow.',
    },
    {
      icon: '🛡️',
      title: 'Security-first, fail-closed',
      desc: 'Kill switch, amount caps, test/live network separation, and a 10-layer security model — enforced at the gateway, not just documented.',
    },
    {
      icon: '📊',
      title: 'Full audit trail',
      desc: 'Every challenge, verification, limit change, and key event is logged per tenant with typed event codes and no PII in log lines.',
    },
  ]

  const onboarding = [
    { step: '1', label: 'Apply', sub: 'Business details + KYB application' },
    { arrow: true },
    { step: '2', label: 'Reviewed', sub: 'Compliance check · 2–5 days' },
    { arrow: true },
    { step: '3', label: 'Test + trial', sub: 'Testnet & capped mainnet · 60 days' },
    { arrow: true },
    { step: '4', label: 'KYB docs', sub: 'Submit required documents' },
    { arrow: true },
    { step: '5', label: 'Activate live', sub: 'POST activate-live → no caps' },
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
            Live — Multi-Tenant Payment Platform
          </div>
          <h2 className="text-4xl md:text-5xl font-black leading-tight mb-4">
            Hosted payment infrastructure<br />
            <span className="gradient-text">for businesses</span>
          </h2>
          <p className="text-gray max-w-xl mx-auto leading-relaxed">
            AlgoVoi-Hand is a managed, compliance-ready crypto payment gateway.
            Register as a tenant, pass a compliance review, and accept payments on
            four chains — without running nodes, facilitators, or verification servers.
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

        {/* Tenant registration code */}
        <div className="max-w-4xl mx-auto mb-14">
          <div className="bg-surf1 border border-border rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surf2">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              <span className="text-[11px] text-gray ml-2">Register your tenant — control plane API</span>
            </div>
            <pre className="text-xs leading-relaxed p-4 overflow-x-auto text-text font-mono">
{`# Control plane — create tenant (after KYB application approved)
POST https://cp.ilovechicken.co.uk/tenants
Authorization: Bearer <admin-key>

{
  "display_name": "Acme Payments Ltd",
  "networks": ["algorand_mainnet", "voi_mainnet"],
  "payout_addresses": {
    "algorand_mainnet": "AAAA…ZZZZ",
    "voi_mainnet":      "BBBB…YYYY"
  },
  # Simplified CDD — required before first mainnet payment
  "legal_entity_name": "Acme Payments Ltd",
  "jurisdiction":       "GB",
  "contact_name":       "Jane Smith"
}

# → 201  { "id": "uuid", "short_id": "acme-x4f2",
#           "mode": "test", "kyb_status": "pending" }

# Issue a tenant API key (shown once only)
POST /tenants/{id}/apikeys
# → { "key": "ak_live_…" }`}
            </pre>
          </div>
        </div>

        {/* Mode & compliance callout */}
        <div className="max-w-4xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-4 mb-14">
          <div className="bg-surf1 border border-border rounded-2xl p-5">
            <div className="text-lg mb-2">🧪</div>
            <div className="text-sm font-bold text-text mb-1">60-day free trial</div>
            <div className="text-xs text-gray leading-relaxed">
              Full testnet access plus capped mainnet ($1k/day) during your trial.
              Identical API surface, zero code change when you go live. No platform fees.
            </div>
          </div>
          <div className="bg-surf1 border border-border rounded-2xl p-5">
            <div className="text-lg mb-2">✅</div>
            <div className="text-sm font-bold text-text mb-1">KYB required for live</div>
            <div className="text-xs text-gray leading-relaxed">
              Submit KYB documents for a compliance review before live mode.
              UK-regulated under MLRs 2017 and SAMLA 2018 — no shortcuts.
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

        {/* Trial CTA */}
        <div className="bg-gradient-to-r from-algo/10 via-voi/10 to-emerald-400/10 border border-algo/20 rounded-2xl p-8 text-center mt-4">
          <h3 className="text-xl sm:text-2xl font-black text-text mb-2">Apply for your free trial</h3>
          <p className="text-sm text-gray mb-6 max-w-lg mx-auto">
            Submit a short business application. Our team reviews all requests within 2–5 business days
            — you'll get 60 days of testnet access and capped mainnet with zero platform fees.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="https://api1.ilovechicken.co.uk/signup"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block gradient-btn text-[#0D1117] font-bold px-8 py-3.5 rounded-xl text-sm"
            >
              Apply for Free Trial →
            </a>
            <a
              href="https://api1.ilovechicken.co.uk/dashboard/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block bg-surf1 border border-border text-text font-bold px-8 py-3.5 rounded-xl text-sm hover:bg-surf2 transition-colors"
            >
              Sign in to Dashboard
            </a>
          </div>
          <div className="flex flex-wrap gap-4 justify-center mt-5 text-[11px] text-gray">
            <span>✓ 60-day free trial</span>
            <span>✓ No platform fees in trial</span>
            <span>✓ Reviewed in 2–5 days</span>
            <span>✓ UK-regulated · MLRs 2017</span>
            <span>✓ Testnet + mainnet (capped)</span>
          </div>
        </div>
      </div>
    </section>
  )
}
