export default function NotificationsSection() {
  const destinations = [
    { logo: '💼', name: 'Slack',           sub: 'Block Kit message' },
    { logo: '📣', name: 'Discord',         sub: 'Embed in any channel' },
    { logo: '🟪', name: 'Microsoft Teams', sub: 'Adaptive Card' },
    { logo: '🟣', name: 'Mattermost',      sub: 'Slack-compatible' },
    { logo: '🚀', name: 'Rocket.Chat',     sub: 'Self-hosted' },
    { logo: '💭', name: 'Google Chat',     sub: 'Cards v2' },
    { logo: '🟢', name: 'Zulip',           sub: 'Topic-threaded' },
    { logo: '📨', name: 'Telegram',        sub: 'Bot sendMessage' },
    { logo: '🪝', name: 'Generic webhook', sub: 'Your own backend' },
  ]

  const reliability = [
    {
      icon: '🔁',
      title: 'Auto-retry up to 32 hours',
      desc: 'Slack down? Receiver flaky? Failed deliveries automatically re-fire with exponential backoff (30s → 2m → 10m → 1h → 6h → dead-letter). Six attempts over ~32 hours before we stop trying.',
    },
    {
      icon: '🔐',
      title: 'HMAC-SHA256 signed payloads',
      desc: "Every outbound POST carries an X-AlgoVoi-Signature header in Stripe-style format (t=<unix>,v1=<hex>). Per-destination algvw_* secret you can rotate from the dashboard. Verify before trusting the data.",
    },
    {
      icon: '📋',
      title: 'Per-tenant audit log',
      desc: 'Every dispatch attempt is recorded — status, attempts, last HTTP code, last error, payload preview. Filterable by provider and status, paginated, no SQL access required.',
    },
    {
      icon: '↻',
      title: 'Manual retry, one click',
      desc: 'Receiver fixed an outage? Hit Retry on a failed delivery. Same path as the worker — same idempotency, same signature, same payload. No replay attack surface.',
    },
    {
      icon: '🌐',
      title: 'One pipeline, nine destinations',
      desc: 'Same retry queue, same signing, same audit log behind every destination. No drift between channels. Adding a tenth destination is a one-file change for us — the existing nine just keep working.',
    },
    {
      icon: '⚡',
      title: 'Real-time, fail-soft',
      desc: 'First delivery attempt fires inline at payment confirmation — typical end-to-end latency is sub-second. Notifier failures NEVER block the on-chain confirmation; you always get paid even if Slack is down.',
    },
  ]

  return (
    <section id="notifications" className="py-24 px-6 relative overflow-hidden">
      {/* Background glows */}
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#10B9810D,transparent 70%)', left: '-100px', top: '0' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF0D,transparent 70%)', right: '-100px', bottom: '0' }} />

      <div className="max-w-6xl mx-auto relative z-10">
        {/* Heading */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            Live — Stripe-grade outbound webhooks
          </div>
          <h2 className="text-4xl md:text-5xl font-black leading-tight mb-4">
            Get notified the moment<br />
            <span className="gradient-text">a payment confirms</span>
          </h2>
          <p className="text-gray max-w-xl mx-auto leading-relaxed">
            Wire AlgoVoi to wherever your team already is — Slack, Teams, Discord, Telegram, or your
            own backend. Auto-retry for 32 hours, HMAC-signed payloads, full audit log, manual retry.
            Same reliability stack behind every destination.
          </p>
        </div>

        {/* 9 destinations grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-12">
          {destinations.map(d => (
            <div key={d.name} className="bg-surf1 border border-border rounded-xl p-4 text-center hover:border-algo/40 transition-colors">
              <div className="text-3xl mb-2">{d.logo}</div>
              <div className="text-sm font-bold text-text">{d.name}</div>
              <div className="text-[11px] text-gray mt-0.5">{d.sub}</div>
            </div>
          ))}
        </div>

        {/* Reliability feature grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-14">
          {reliability.map(f => (
            <div key={f.title} className="bg-surf1 border border-border rounded-2xl p-5 hover:border-algo/40 transition-colors">
              <div className="text-2xl mb-3">{f.icon}</div>
              <div className="text-sm font-bold text-text mb-1.5">{f.title}</div>
              <div className="text-xs text-gray leading-relaxed">{f.desc}</div>
            </div>
          ))}
        </div>

        {/* Generic webhook event sample */}
        <div className="max-w-4xl mx-auto mb-14">
          <div className="text-xs text-gray text-center mb-3 uppercase tracking-widest">Generic webhook event</div>
          <div className="bg-surf1 border border-border rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surf2">
              <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
              <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              <span className="text-[11px] text-gray ml-2">POST your-backend.example.com  ·  X-AlgoVoi-Signature: t=1777200000,v1=…</span>
            </div>
            <pre className="text-xs leading-relaxed p-4 overflow-x-auto text-text font-mono">
{`{
  "id":          "evt_a3f7c192-d8e1-4b6c-9f0a-7b1e2c4d8e3f",
  "type":        "payment.confirmed",
  "created":     1777200000,
  "api_version": "1",
  "data": {
    "tenant_label":      "Acme Payments Ltd",
    "resource_id":       "premium-content",
    "chain":             "algorand:mainnet",
    "asset":             { "id": "31566704", "label": "USDC", "decimals": 6 },
    "amount_microunits": "5000000",
    "amount_pretty":     "5 USDC",
    "tx_id":             "ABCD1234EFGH5678ABCD1234EFGH5678ABCD1234EFGH5678ABCD",
    "payer_address":     "GHSRL2SAY247…MWI"
  }
}

# Verify in Python
expected = hmac.new(SECRET.encode(), f"{ts}.".encode() + raw_body, hashlib.sha256).hexdigest()
if not hmac.compare_digest(expected, v1):
    abort(401)`}
            </pre>
          </div>
        </div>

        {/* CTA */}
        <div className="bg-gradient-to-r from-algo/10 via-emerald-400/10 to-voi/10 border border-algo/20 rounded-2xl p-6 sm:p-8 text-center">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-3 py-1 text-[11px] text-gray mb-4">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Same offer · 60 days testnet · KYC unlocks $1,000 free mainnet · 0.50% after
          </div>
          <h3 className="text-xl sm:text-2xl font-black text-text mb-2">Wire your stack in two minutes</h3>
          <p className="text-sm text-gray mb-6 max-w-lg mx-auto">
            Paste a Slack incoming-webhook URL, a Discord channel webhook, a Teams workflow URL — or
            point AlgoVoi at your own backend. Every destination shares the same retry queue, same
            signing layer, same audit page. No infrastructure to run.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="https://dash.algovoi.co.uk/connect"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block gradient-btn text-[#0D1117] font-bold px-8 py-3.5 rounded-xl text-sm"
            >
              Configure notifications →
            </a>
            <a
              href="https://dash.algovoi.co.uk/notifications"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block bg-surf1 border border-border text-text font-bold px-8 py-3.5 rounded-xl text-sm hover:bg-surf2 transition-colors"
            >
              View delivery audit log
            </a>
          </div>
          <div className="flex flex-wrap gap-4 justify-center mt-5 text-[11px] text-gray">
            <span>✓ 9 destinations</span>
            <span>✓ HMAC-SHA256 signed</span>
            <span>✓ Auto-retry 32h</span>
            <span>✓ Manual retry</span>
            <span>✓ Per-tenant audit log</span>
          </div>
        </div>
      </div>
    </section>
  )
}
