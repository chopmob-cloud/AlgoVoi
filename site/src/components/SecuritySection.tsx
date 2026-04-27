export default function SecuritySection() {
  const layers = [
    {
      icon: '🔒',
      title: 'TLS & Edge Protection',
      subtitle: 'Nginx',
      points: [
        'TLS 1.2+ only with strong ciphers',
        'HSTS enforced (1 year, includeSubDomains)',
        'Rate limiting: 5 req/min auth, 60 req/min API',
        'Max 20 concurrent connections per IP',
        'Admin API restricted to localhost',
      ],
    },
    {
      icon: '🛡️',
      title: 'API Authentication',
      subtitle: 'Gateway',
      points: [
        'Argon2id-hashed API keys (64 MiB memory cost)',
        'Timing-safe comparison prevents oracle attacks',
        'Per-tenant rate limiting + RLS context isolation',
        '64 KB body size limit on all requests',
        'CSP headers: default-src none on API routes',
      ],
    },
    {
      icon: '💳',
      title: 'Hosted Checkout',
      subtitle: 'Payment pages',
      points: [
        'All display values HTML-escaped (XSS prevention)',
        'Amount & receiver always from database (never client)',
        'Memo binding verified on-chain (replay prevention)',
        'Payment link tokens: 192-bit cryptographic random',
        'Kill switch check before rendering',
      ],
    },
    {
      icon: '🔗',
      title: 'On-Chain Verification',
      subtitle: 'Facilitator',
      points: [
        'HMAC-SHA256 signed internal requests',
        '60-second replay protection window',
        'Direct indexer/Mirror Node verification',
        'Supports Algorand, VOI, Hedera, Stellar, Base, Solana, and Tempo',
        'Integer-only arithmetic (no float rounding)',
      ],
    },
    {
      icon: '🏛️',
      title: 'Admin & Control Plane',
      subtitle: 'Operator API',
      points: [
        'Three-path auth: static key / JWT / DB-backed keys',
        'IP allowlist checked before key verification',
        'Granular scope enforcement (14 permission atoms)',
        'Full audit trail on every admin action',
        'CORS whitelist with wildcard guard at startup',
      ],
    },
    {
      icon: '🗄️',
      title: 'Database Security',
      subtitle: 'PostgreSQL',
      points: [
        'Row-Level Security policies per tenant',
        'SET LOCAL scoping (no state leakage)',
        'Internal Docker network only (no external access)',
        'Connection validation with pool_pre_ping',
        'Loopback port binding (127.0.0.1)',
      ],
    },
    {
      icon: '🔐',
      title: 'Encryption at Rest',
      subtitle: 'Cryptography',
      points: [
        'Fernet (AES-128-CBC + HMAC-SHA256) for secrets',
        'MultiFernet for zero-downtime key rotation',
        'API keys: Argon2id one-way hash (never stored)',
        'Webhook secrets: cryptographically random per integration',
        'Sponsor mnemonics encrypted before storage',
      ],
    },
    {
      icon: '📊',
      title: 'Price Oracle',
      subtitle: 'Fiat conversion',
      points: [
        'CoinGecko response capped at 64 KB (OOM prevention)',
        'Plausibility bounds: $0.001 - $100K per unit',
        'Pure integer arithmetic (zero float precision loss)',
        '30-minute staleness check with error fallback',
        'Background loop independent of request traffic',
      ],
    },
    {
      icon: '🐳',
      title: 'Infrastructure',
      subtitle: 'Docker & Containers',
      points: [
        'All services run as non-root (appuser)',
        'Network segregation: public + internal networks',
        'Only nginx exposes ports 80/443',
        'Minimal base images (python:slim, nginx:alpine)',
        'Log rotation: 50 MB max, 5 files',
      ],
    },
    {
      icon: '⚙️',
      title: 'Configuration Safety',
      subtitle: 'Startup validation',
      points: [
        'All secrets enforced at minimum 32 characters',
        'Production mode blocks dev-only features',
        'Fernet key format validated at startup',
        'Localhost DB URL rejected in production',
        'Secret values never logged (only length)',
      ],
    },
  ]

  return (
    <section id="security" className="py-24 px-6 relative overflow-hidden">
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#10B98118,transparent 70%)', left: '-100px', top: '200px' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#3B82F618,transparent 70%)', right: '-100px', bottom: '200px' }} />

      <div className="max-w-6xl mx-auto relative z-10">
        <div className="text-center mb-16">
          <h2 className="text-4xl font-black leading-tight mb-4">
            10-Layer<br />
            <span className="gradient-text">Security Stack</span>
          </h2>
          <p className="text-gray max-w-2xl mx-auto leading-relaxed">
            Every request passes through multiple independent security layers.
            Defence-in-depth from the network edge to on-chain verification.
          </p>
        </div>

        {/* Payment flow trace */}
        <div className="bg-surf1/50 border border-border/50 rounded-2xl p-4 sm:p-6 mb-12">
          <h3 className="text-sm font-bold text-gray uppercase tracking-wider mb-4">Payment Flow Security Trace</h3>
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 sm:items-center sm:justify-center">
            {[
              'Token validated',
              'Link from DB',
              'Kill switch check',
              'HTML escaped',
              'Amount from DB',
              'Memo on-chain',
              'HMAC signed',
              'Indexer verified',
              'Ledger idempotent',
              'Redirect',
            ].map((step, i) => (
              <div key={step} className="flex items-center gap-2">
                <span className="bg-surf2 border border-border rounded-lg px-3 py-1.5 text-xs font-medium text-text whitespace-nowrap">
                  {step}
                </span>
                {i < 9 && <span className="text-gray text-xs">→</span>}
              </div>
            ))}
          </div>
        </div>

        {/* Security layers grid */}
        <div className="grid md:grid-cols-2 gap-4">
          {layers.map((layer) => (
            <div key={layer.title} className="bg-surf1/30 border border-border/50 rounded-2xl p-5 hover:border-border transition-colors">
              <div className="flex items-start gap-3 mb-3">
                <span className="text-2xl">{layer.icon}</span>
                <div>
                  <h3 className="text-base font-bold text-text leading-tight">{layer.title}</h3>
                  <p className="text-xs text-gray">{layer.subtitle}</p>
                </div>
              </div>
              <ul className="space-y-1.5">
                {layer.points.map((point) => (
                  <li key={point} className="flex items-start gap-2 text-xs text-gray leading-relaxed">
                    <span className="text-green-400 mt-0.5 flex-shrink-0">&#10003;</span>
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom note */}
        <div className="mt-12 text-center">
          <p className="text-xs text-gray max-w-xl mx-auto">
            All security controls are code-verified against the production codebase.
            Full technical audit available at{' '}
            <a href="https://github.com/chopmob-cloud/AlgoVoi-Hand/blob/master/docs/SECURITY_OVERVIEW.md"
              target="_blank" rel="noopener noreferrer"
              className="text-accent hover:underline">
              docs/SECURITY_OVERVIEW.md
            </a>
          </p>
        </div>
      </div>
    </section>
  )
}
