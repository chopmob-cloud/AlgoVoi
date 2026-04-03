export default function EcommerceSection() {
  const platforms = [
    {
      name: 'WooCommerce',
      icon: '🟣',
      url: 'https://woocommerce.ilovechicken.co.uk',
      hosted: true,
      extension: true,
      chains: { hosted: ['Algorand', 'VOI', 'Hedera'], extension: ['Algorand', 'VOI'] },
      desc: 'WordPress + WooCommerce plugin with hosted checkout redirect and in-page browser extension payment.',
    },
    {
      name: 'OpenCart',
      icon: '🔵',
      url: 'https://opencart.ilovechicken.co.uk',
      hosted: true,
      extension: true,
      chains: { hosted: ['Algorand', 'VOI', 'Hedera'], extension: ['Algorand', 'VOI'] },
      desc: 'OpenCart 4 extension with AJAX-powered checkout, chain selector, and dark-themed storefront.',
    },
    {
      name: 'PrestaShop',
      icon: '🩷',
      url: 'https://prestashop.ilovechicken.co.uk',
      hosted: true,
      extension: true,
      chains: { hosted: ['Algorand', 'VOI', 'Hedera'], extension: ['Algorand', 'VOI'] },
      desc: 'PrestaShop 8 module with custom payment options, cookie-secured sessions, and full dark theme.',
    },
    {
      name: 'Shopware',
      icon: '🟢',
      url: 'https://shopware.ilovechicken.co.uk',
      hosted: true,
      extension: true,
      chains: { hosted: ['Algorand', 'VOI', 'Hedera'], extension: ['Algorand', 'VOI'] },
      desc: 'Shopware 6 plugin with Symfony payment handlers, Twig chain selector, and webhook verification.',
    },
  ]

  const chainColour: Record<string, string> = {
    Algorand: 'text-algo',
    VOI: 'text-voi',
    Hedera: 'text-emerald-400',
  }

  const securityFeatures = [
    { icon: '🔐', title: 'HMAC webhook verification', desc: 'Signed webhooks with hash_equals — empty secrets rejected before HMAC check.' },
    { icon: '🛡️', title: 'SSRF protection', desc: 'Checkout URL host validated against configured API base before any server-side fetch.' },
    { icon: '⏱️', title: 'Timing-safe comparisons', desc: 'hash_equals for all secret comparisons — order keys, HMAC signatures, tokens.' },
    { icon: '✅', title: 'Cancel-bypass prevention', desc: 'Hosted checkout returns verified via API before marking orders complete. No blind trust.' },
    { icon: '👤', title: 'Order ownership checks', desc: 'Customer ID cross-referenced on verify endpoints — prevents cookie-swap attacks.' },
    { icon: '🔒', title: 'TLS enforced', desc: 'SSL verification enabled on all outbound HTTP calls across every platform.' },
  ]

  const flow = [
    { step: '1', label: 'Customer selects chain', sub: 'Algorand · VOI · Hedera' },
    { step: '2', label: 'Plugin creates payment link', sub: 'POST /v1/payment-links' },
    { step: '3', label: 'Hosted: redirect to checkout', sub: 'Extension: pay in-page via wallet' },
    { step: '4', label: 'On-chain verification', sub: 'Webhook or API status check' },
    { step: '5', label: 'Order confirmed', sub: 'Status updated automatically' },
  ]

  return (
    <section id="ecommerce" className="py-24 px-6 relative overflow-hidden">
      {/* Background glows */}
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#10b98110,transparent 70%)', left: '-100px', top: '100px' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF0D,transparent 70%)', right: '-100px', bottom: '100px' }} />

      <div className="max-w-6xl mx-auto relative z-10">
        {/* Heading */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Live — eCommerce Payment Adapters
          </div>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-black leading-tight mb-4">
            Accept crypto on<br />
            <span className="gradient-text">any eCommerce platform</span>
          </h2>
          <p className="text-gray max-w-2xl mx-auto leading-relaxed text-sm sm:text-base">
            Drop-in payment plugins for the world's most popular eCommerce platforms.
            USDC on Algorand, aUSDC on VOI, and USDC on Hedera — with hosted checkout
            and browser extension payment flows.
          </p>
        </div>

        {/* Two gateway types */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-16 max-w-4xl mx-auto">
          <div className="bg-surf1 border border-border rounded-2xl p-5 sm:p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-algo/10 border border-algo/20 flex items-center justify-center text-lg">🌐</div>
              <div>
                <div className="text-sm font-bold text-text">Hosted Checkout</div>
                <div className="text-xs text-gray">Redirect to AlgoVoi</div>
              </div>
            </div>
            <p className="text-xs text-gray leading-relaxed mb-3">
              Customer is redirected to a secure AlgoVoi-hosted payment page.
              Supports any wallet — no extension required. Payment confirmed via webhook.
            </p>
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] bg-algo/10 text-algo border border-algo/20 rounded-full px-2.5 py-0.5">Algorand</span>
              <span className="text-[10px] bg-voi/10 text-voi border border-voi/20 rounded-full px-2.5 py-0.5">VOI</span>
              <span className="text-[10px] bg-emerald-400/10 text-emerald-400 border border-emerald-400/20 rounded-full px-2.5 py-0.5">Hedera</span>
            </div>
          </div>
          <div className="bg-surf1 border border-border rounded-2xl p-5 sm:p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-xl bg-voi/10 border border-voi/20 flex items-center justify-center text-lg">⚡</div>
              <div>
                <div className="text-sm font-bold text-text">Extension Payment</div>
                <div className="text-xs text-gray">Pay in-page via AlgoVoi wallet</div>
              </div>
            </div>
            <p className="text-xs text-gray leading-relaxed mb-3">
              Customer pays directly on the store page using the AlgoVoi browser extension.
              No redirect, instant on-chain settlement via algosdk.
            </p>
            <div className="flex flex-wrap gap-1.5">
              <span className="text-[10px] bg-algo/10 text-algo border border-algo/20 rounded-full px-2.5 py-0.5">Algorand</span>
              <span className="text-[10px] bg-voi/10 text-voi border border-voi/20 rounded-full px-2.5 py-0.5">VOI</span>
            </div>
          </div>
        </div>

        {/* Payment flow */}
        <div className="mb-16">
          <div className="text-xs text-gray text-center mb-4 uppercase tracking-widest">Payment flow</div>
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 max-w-4xl mx-auto">
            {flow.map((item, i) => (
              <div key={i} className="bg-surf1/60 border border-border/60 rounded-xl p-3 sm:p-4 text-center relative">
                {i < flow.length - 1 && (
                  <div className="hidden sm:block absolute -right-2.5 top-1/2 -translate-y-1/2 text-muted text-sm z-10">→</div>
                )}
                <div className="w-7 h-7 rounded-full border border-algo/40 flex items-center justify-center text-xs font-black text-algo mx-auto mb-2">
                  {item.step}
                </div>
                <div className="text-xs font-semibold text-text leading-tight">{item.label}</div>
                <div className="text-[10px] text-gray mt-0.5">{item.sub}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Platform cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-16">
          {platforms.map(p => (
            <div key={p.name} className="bg-surf1 border border-border rounded-2xl p-5 sm:p-6 hover:border-algo/40 transition-colors">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-2xl">{p.icon}</span>
                <div>
                  <div className="text-sm font-bold text-text">{p.name}</div>
                  <div className="flex gap-1.5 mt-1">
                    {p.hosted && <span className="text-[10px] bg-surf2 border border-border rounded-full px-2 py-0.5 text-gray">Hosted</span>}
                    {p.extension && <span className="text-[10px] bg-surf2 border border-border rounded-full px-2 py-0.5 text-gray">Extension</span>}
                  </div>
                </div>
              </div>
              <p className="text-xs text-gray leading-relaxed mb-3">{p.desc}</p>
              <div className="mb-3">
                <div className="text-[10px] text-muted uppercase tracking-wider mb-1">Hosted chains</div>
                <div className="flex flex-wrap gap-1">
                  {p.chains.hosted.map(c => (
                    <span key={c} className={`text-[10px] font-medium ${chainColour[c]}`}>{c}</span>
                  ))}
                </div>
                <div className="text-[10px] text-muted uppercase tracking-wider mb-1 mt-2">Extension chains</div>
                <div className="flex flex-wrap gap-1">
                  {p.chains.extension.map(c => (
                    <span key={c} className={`text-[10px] font-medium ${chainColour[c]}`}>{c}</span>
                  ))}
                </div>
              </div>
              <a
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-algo hover:text-text transition-colors"
              >
                Visit demo store →
              </a>
            </div>
          ))}
        </div>

        {/* Security */}
        <div className="mb-14">
          <div className="text-center mb-8">
            <h3 className="text-xl sm:text-2xl font-black text-text mb-2">Security-first architecture</h3>
            <p className="text-xs sm:text-sm text-gray">Every adapter is hardened against real-world payment attack vectors.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {securityFeatures.map(f => (
              <div key={f.title} className="bg-surf1 border border-border rounded-2xl p-4 sm:p-5">
                <div className="text-xl mb-2">{f.icon}</div>
                <div className="text-xs font-bold text-text mb-1">{f.title}</div>
                <div className="text-[11px] text-gray leading-relaxed">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* CTA */}
        <div className="text-center">
          <p className="text-gray text-sm mb-4">Want AlgoVoi payments on your store?</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <a
              href="https://api1.ilovechicken.co.uk/signup"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block gradient-btn text-[#0D1117] font-bold px-8 py-3 rounded-xl text-sm"
            >
              Start Free Trial →
            </a>
            <a
              href="https://github.com/ArbiterFi/platform-adapters"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block bg-surf1 border border-border text-text font-bold px-8 py-3 rounded-xl text-sm hover:bg-surf2 transition-colors"
            >
              View on GitHub
            </a>
          </div>
        </div>
      </div>
    </section>
  )
}
