import PopupShell from './PopupShell'

export default function AgentScreen() {
  return (
    <section id="agents" className="py-24 px-6 relative overflow-hidden">
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', left: '-100px', top: '50px' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', right: '-100px', top: '150px' }} />

      <div className="max-w-6xl mx-auto relative z-10">
        {/* Heading */}
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-voi animate-pulse" />
            WalletConnect v2 · AP2 (Google Agent Payments)
          </div>
          <h2 className="text-4xl md:text-5xl font-black leading-tight mb-4">
            Built for<br />
            <span className="gradient-text-rev">AI agents</span>
          </h2>
          <p className="text-gray max-w-xl mx-auto leading-relaxed">
            Two protocols. One wallet. AI agents can request transaction signing
            via WalletConnect, or sign Google AP2 payment mandates — all with
            user approval. Your keys never leave the device.
          </p>
        </div>

        {/* Two-column: WC agent sign + AP2 */}
        <div className="flex flex-col lg:flex-row gap-10 items-start justify-center mb-16">

          {/* WalletConnect agent signing */}
          <div className="flex flex-col items-center gap-6 flex-1 max-w-sm">
            <div className="text-center">
              <div className="text-2xl mb-2">🔗</div>
              <div className="text-lg font-black mb-1">WalletConnect Signing</div>
              <div className="text-xs text-gray">Agent connects via WC QR, requests <code className="text-algo bg-surf2 px-1 rounded">algo_signTxn</code></div>
            </div>
            <PopupShell width="w-[340px]">
              {/* Header */}
              <div className="flex items-center gap-2.5 px-4 pt-4 pb-0">
                <div className="w-8 h-8 rounded-[8px] flex items-center justify-center text-xs"
                  style={{ background: 'linear-gradient(135deg,#8B5CF6,#00C8FF)' }}>
                  🤖
                </div>
                <div>
                  <div className="text-xs font-bold">Agent Sign Request</div>
                  <div className="text-[10px] text-gray mt-0.5">TradingBot v2 · Voi Mainnet</div>
                </div>
                <div className="ml-auto text-[10px] text-voi font-semibold border border-voi/40 bg-voi/10 rounded px-1.5 py-0.5">
                  WalletConnect
                </div>
              </div>

              <div className="px-4 py-3">
                <div className="bg-surf1 rounded-[10px] px-3 py-2 mb-2.5 border border-border">
                  <div className="text-[10px] text-gray mb-0.5">Agent</div>
                  <div className="text-xs font-semibold">tradingbot.ai</div>
                </div>

                {/* Txn summary */}
                <div className="bg-surf1 rounded-[10px] px-3 py-2.5 mb-2.5 border border-border">
                  <div className="flex justify-between text-[10px] text-gray mb-1.5">
                    <span>Transaction 1 of 1</span>
                    <span className="text-voi font-semibold">pay</span>
                  </div>
                  {[
                    { label: 'From',   value: 'VPAB…7G3K', mono: true },
                    { label: 'To',     value: 'RECV…9ABC', mono: true },
                    { label: 'Amount', value: '5.00 VOI', color: '#8B5CF6' },
                    { label: 'Fee',    value: '0.001 VOI' },
                  ].map(r => (
                    <div key={r.label} className="flex justify-between text-[10px] text-gray">
                      <span>{r.label}</span>
                      <span className={`font-semibold text-text ${r.mono ? 'font-mono' : ''}`}
                        style={r.color ? { color: r.color } : {}}>
                        {r.value}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="text-[9px] text-muted text-center mb-2">
                  Expires in 4:47 · You remain in full control
                </div>
              </div>

              <div className="flex gap-2 px-4 pb-4">
                <button className="flex-1 py-2 rounded-xl bg-surf2 border border-border text-xs font-bold text-text">
                  Reject
                </button>
                <button className="flex-1 py-2 rounded-xl gradient-btn text-xs font-bold text-[#0D1117]">
                  Sign &amp; Send
                </button>
              </div>
            </PopupShell>
          </div>

          {/* Divider */}
          <div className="hidden lg:flex flex-col items-center justify-center self-stretch gap-2 text-muted text-xs">
            <div className="w-px flex-1 bg-border" />
            <span>or</span>
            <div className="w-px flex-1 bg-border" />
          </div>

          {/* AP2 */}
          <div className="flex flex-col items-center gap-6 flex-1 max-w-sm">
            <div className="text-center">
              <div className="text-2xl mb-2">🛒</div>
              <div className="text-lg font-black mb-1">AP2 Payment Mandate</div>
              <div className="text-xs text-gray">Google Agent Payments Protocol — signs ed25519 credential, no on-chain txn required</div>
            </div>
            <PopupShell width="w-[340px]">
              {/* Header */}
              <div className="flex items-center gap-2.5 px-4 pt-4 pb-0">
                <div className="w-8 h-8 rounded-[8px] flex items-center justify-center text-xs"
                  style={{ background: 'linear-gradient(135deg,#00C8FF,#8B5CF6)' }}>
                  🛒
                </div>
                <div>
                  <div className="text-xs font-bold">AP2 Payment Request</div>
                  <div className="text-[10px] text-gray mt-0.5">shopping-agent.ai · Algorand</div>
                </div>
                <div className="ml-auto text-[10px] text-algo font-semibold border border-algo/40 bg-algo/10 rounded px-1.5 py-0.5">
                  AP2
                </div>
              </div>

              <div className="px-4 py-3">
                {/* Cart */}
                <div className="bg-surf1 rounded-[10px] px-3 py-2.5 mb-2.5 border border-border">
                  <div className="text-[10px] text-gray mb-2">Cart contents</div>
                  {[
                    { label: 'API access — 1h',  amount: '$4.99' },
                    { label: 'Data export',       amount: '$0.99' },
                  ].map(item => (
                    <div key={item.label} className="flex justify-between text-[10px] text-text mb-1 last:mb-0">
                      <span>{item.label}</span>
                      <span className="font-semibold">{item.amount}</span>
                    </div>
                  ))}
                  <div className="border-t border-border mt-2 pt-2 flex justify-between text-xs font-black">
                    <span className="text-gray">Total</span>
                    <span className="gradient-text">$5.98 USD</span>
                  </div>
                </div>

                <div className="bg-surf1 rounded-[10px] px-3 py-2 mb-2.5 border border-border">
                  {[
                    { label: 'Merchant', value: 'merchant-id: shop42' },
                    { label: 'Signing',  value: 'ed25519 credential' },
                    { label: 'Address',  value: 'ABC4…XY12', mono: true },
                  ].map(r => (
                    <div key={r.label} className="flex justify-between text-[10px] text-gray">
                      <span>{r.label}</span>
                      <span className={`font-semibold text-text ${r.mono ? 'font-mono' : ''}`}>{r.value}</span>
                    </div>
                  ))}
                </div>

                <div className="text-[9px] text-muted text-center mb-2">
                  Credential only — no on-chain transaction · Expires in 8:12
                </div>
              </div>

              <div className="flex gap-2 px-4 pb-4">
                <button className="flex-1 py-2 rounded-xl bg-surf2 border border-border text-xs font-bold text-text">
                  Reject
                </button>
                <button className="flex-1 py-2 rounded-xl gradient-btn text-xs font-bold text-[#0D1117]">
                  Sign Mandate
                </button>
              </div>
            </PopupShell>
          </div>
        </div>

        {/* Protocol comparison table */}
        <div className="max-w-3xl mx-auto bg-surf1 border border-border rounded-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surf2">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
            <span className="text-[11px] text-gray ml-2">Agent payment protocol comparison</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2.5 text-gray font-semibold">Protocol</th>
                  <th className="text-left px-4 py-2.5 text-gray font-semibold">Trigger</th>
                  <th className="text-left px-4 py-2.5 text-gray font-semibold">On-chain txn</th>
                  <th className="text-left px-4 py-2.5 text-gray font-semibold">Best for</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { proto: 'x402',  trigger: 'HTTP 402 response',              chain: 'Yes — AVM pay txn',     for: 'Web content / APIs' },
                  { proto: 'MPP',   trigger: 'WWW-Authenticate: Payment',      chain: 'Yes — AVM charge txn',  for: 'Machine-to-machine APIs' },
                  { proto: 'AP2',   trigger: 'window.algorand.ap2.request()',   chain: 'No — ed25519 mandate',  for: 'AI agent commerce' },
                  { proto: 'WC',    trigger: 'algo_signTxn via WalletConnect', chain: 'Yes — any AVM txn',     for: 'AI agent arbitrary signing' },
                ].map((r, i) => (
                  <tr key={r.proto} className={i < 3 ? 'border-b border-border/50' : ''}>
                    <td className="px-4 py-2.5 font-bold text-text">{r.proto}</td>
                    <td className="px-4 py-2.5 font-mono text-gray text-[10px]">{r.trigger}</td>
                    <td className="px-4 py-2.5 text-gray">{r.chain}</td>
                    <td className="px-4 py-2.5 text-gray">{r.for}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  )
}
