import PopupShell from './PopupShell'

/**
 * Step-by-step visual guide: install → create wallet → connect WC → deploy vault → opt-in tokens → fund
 */
export default function GetStartedScreen() {
  return (
    <section id="get-started" className="py-24 px-6 relative overflow-hidden">
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF10,transparent 70%)', left: '-120px', top: '0' }} />

      <div className="max-w-6xl mx-auto relative z-10">
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            5 minutes to set up
          </div>
          <h2 className="text-4xl font-black leading-tight mb-4">
            Get started with<br />
            <span className="gradient-text">AlgoVoi</span>
          </h2>
          <p className="text-gray max-w-lg mx-auto">
            From install to autonomous payments in five steps. Your vault handles
            x402 and MPP payments automatically — no phone needed after setup.
          </p>
        </div>

        {/* Steps grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">

          {/* Step 1: Create wallet */}
          <div className="flex flex-col items-center">
            <div className="w-8 h-8 rounded-full gradient-btn flex items-center justify-center text-sm font-black text-[#0D1117] mb-4">1</div>
            <h3 className="text-lg font-bold mb-2">Create wallet</h3>
            <p className="text-xs text-gray text-center mb-4">Set a password to encrypt your keys. Everything stays local.</p>
            <PopupShell width="w-[280px]">
              <div className="p-5 space-y-3">
                <div className="text-center">
                  <div className="w-12 h-12 rounded-xl gradient-btn flex items-center justify-center text-lg font-black text-[#0D1117] mx-auto mb-3">AV</div>
                  <div className="text-sm font-bold">Welcome to AlgoVoi</div>
                  <div className="text-[10px] text-gray mt-1">Create a password to secure your wallet</div>
                </div>
                <div className="bg-surf1 rounded-lg px-3 py-2 border border-border">
                  <div className="text-[10px] text-gray">Password</div>
                  <div className="text-xs text-muted mt-0.5">••••••••••••</div>
                </div>
                <div className="bg-surf1 rounded-lg px-3 py-2 border border-border">
                  <div className="text-[10px] text-gray">Confirm</div>
                  <div className="text-xs text-muted mt-0.5">••••••••••••</div>
                </div>
                <button className="w-full py-2 rounded-xl gradient-btn text-xs font-bold text-[#0D1117]">
                  Create Wallet
                </button>
              </div>
            </PopupShell>
          </div>

          {/* Step 2: Connect wallet */}
          <div className="flex flex-col items-center">
            <div className="w-8 h-8 rounded-full gradient-btn flex items-center justify-center text-sm font-black text-[#0D1117] mb-4">2</div>
            <h3 className="text-lg font-bold mb-2">Connect wallet</h3>
            <p className="text-xs text-gray text-center mb-4">Scan the QR with Defly, Pera or Lute to pair your mobile wallet.</p>
            <PopupShell width="w-[280px]">
              <div className="p-5 space-y-3">
                <div className="text-center">
                  <div className="text-sm font-bold mb-1">Connect via WalletConnect</div>
                  <div className="text-[10px] text-gray">Scan with your mobile wallet</div>
                </div>
                {/* QR mockup */}
                <div className="mx-auto w-[160px] h-[160px] rounded-xl bg-white p-3 flex items-center justify-center">
                  <div className="w-full h-full rounded-lg" style={{
                    background: `repeating-conic-gradient(#0D1117 0% 25%, #fff 0% 50%) 50% / 12px 12px`,
                  }} />
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-gray">Supported wallets</div>
                  <div className="flex justify-center gap-3 mt-1.5">
                    {['Defly', 'Pera', 'Lute'].map(w => (
                      <span key={w} className="text-[10px] text-algo border border-algo/30 rounded-full px-2 py-0.5">{w}</span>
                    ))}
                  </div>
                </div>
              </div>
            </PopupShell>
          </div>

          {/* Step 3: Deploy vault */}
          <div className="flex flex-col items-center">
            <div className="w-8 h-8 rounded-full gradient-btn flex items-center justify-center text-sm font-black text-[#0D1117] mb-4">3</div>
            <h3 className="text-lg font-bold mb-2">Deploy vault</h3>
            <p className="text-xs text-gray text-center mb-4">One-time on-chain deployment. Sets your spending limits.</p>
            <PopupShell width="w-[280px]">
              <div className="p-5 space-y-3">
                <div className="text-sm font-bold text-center mb-1">Deploy SpendingCap Vault</div>
                <div className="space-y-2">
                  <div className="bg-surf1 rounded-lg px-3 py-2 border border-border">
                    <div className="text-[10px] text-gray">Max per payment</div>
                    <div className="text-xs font-semibold mt-0.5">1.00 ALGO</div>
                  </div>
                  <div className="bg-surf1 rounded-lg px-3 py-2 border border-border">
                    <div className="text-[10px] text-gray">Max per day</div>
                    <div className="text-xs font-semibold mt-0.5">10.00 ALGO</div>
                  </div>
                  <div className="bg-surf1 rounded-lg px-3 py-2 border border-border">
                    <div className="text-[10px] text-gray">Max per ASA payment</div>
                    <div className="text-xs font-semibold mt-0.5">1.00 USDC</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-gray">
                  <span className="w-3 h-3 rounded border border-algo bg-algo/20 flex items-center justify-center text-[8px] text-algo">✓</span>
                  Agent key auto-generated
                </div>
                <button className="w-full py-2 rounded-xl gradient-btn text-xs font-bold text-[#0D1117]">
                  Deploy Vault
                </button>
              </div>
            </PopupShell>
          </div>

          {/* Step 4: Opt-in tokens */}
          <div className="flex flex-col items-center">
            <div className="w-8 h-8 rounded-full gradient-btn flex items-center justify-center text-sm font-black text-[#0D1117] mb-4">4</div>
            <h3 className="text-lg font-bold mb-2">Add tokens to vault</h3>
            <p className="text-xs text-gray text-center mb-4">Opt the vault into USDC or any ASA so it can auto-pay with them.</p>
            <PopupShell width="w-[280px]">
              <div className="p-5 space-y-2">
                <div className="text-sm font-bold mb-2">Manage tokens</div>
                <div className="text-[10px] text-gray mb-3">Opt the vault into tokens for auto-payments.</div>
                {[
                  { name: 'USDC', id: '#31566704', opted: true },
                  { name: 'aUSDC', id: '#302190', opted: false },
                  { name: 'goUSD', id: '#672913181', opted: false },
                ].map(t => (
                  <div key={t.name} className="flex items-center justify-between py-2 border-b border-surf2/30 last:border-0">
                    <div>
                      <span className="text-xs text-text font-semibold">{t.name}</span>
                      <span className="text-[10px] text-gray ml-1.5">{t.id}</span>
                    </div>
                    {t.opted ? (
                      <span className="text-[10px] text-green-400">✓ Opted in</span>
                    ) : (
                      <button className="text-[10px] px-2 py-0.5 rounded bg-algo/20 text-algo font-semibold">
                        Add to vault
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </PopupShell>
          </div>

          {/* Step 5: Fund vault */}
          <div className="flex flex-col items-center">
            <div className="w-8 h-8 rounded-full gradient-btn flex items-center justify-center text-sm font-black text-[#0D1117] mb-4">5</div>
            <h3 className="text-lg font-bold mb-2">Fund the vault</h3>
            <p className="text-xs text-gray text-center mb-4">Send ALGO for fees + USDC for payments to the vault address.</p>
            <PopupShell width="w-[280px]">
              <div className="p-5 space-y-3">
                <div className="text-sm font-bold mb-1">Fund vault</div>
                <div className="text-[10px] text-gray">Send tokens to this address to top up.</div>
                <div className="bg-surf1 rounded-lg px-3 py-2.5 border border-border">
                  <div className="text-[10px] font-mono text-algo break-all">EBQXIX4PYEIL…EAPOJYJ7RY</div>
                </div>
                <div className="bg-surf1 rounded-[10px] p-3 border border-border space-y-1.5">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-gray">ALGO (fees)</span>
                    <span className="text-text font-semibold">0.50</span>
                  </div>
                  <div className="flex justify-between text-[10px]">
                    <span className="text-gray">USDC (payments)</span>
                    <span className="text-text font-semibold">25.00</span>
                  </div>
                </div>
                <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2 text-center">
                  <div className="text-[10px] text-green-400 font-semibold">✓ Vault ready for auto-payments</div>
                </div>
              </div>
            </PopupShell>
          </div>

          {/* Step 6: Auto-pay */}
          <div className="flex flex-col items-center">
            <div className="w-8 h-8 rounded-full gradient-btn flex items-center justify-center text-sm font-black text-[#0D1117] mb-4">✓</div>
            <h3 className="text-lg font-bold mb-2">Auto-payments live</h3>
            <p className="text-xs text-gray text-center mb-4">x402 and MPP payments flow through the vault — instant, no phone.</p>
            <PopupShell width="w-[280px]">
              <div className="p-5 space-y-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-8 h-8 rounded-[10px] flex items-center justify-center text-sm"
                    style={{ background: 'linear-gradient(135deg,#8B5CF6,#00C8FF)' }}>🔐</div>
                  <div>
                    <div className="text-sm font-bold">Vault active</div>
                    <div className="text-[10px] text-gray">Agent key signing locally</div>
                  </div>
                </div>
                {[
                  { site: 'api.example.com', amount: '0.25 USDC', proto: 'x402', time: 'just now' },
                  { site: 'content.news.io', amount: '0.10 USDC', proto: 'MPP', time: '2s ago' },
                  { site: 'data.service.ai', amount: '0.50 ALGO', proto: 'x402', time: '5s ago' },
                ].map((p, i) => (
                  <div key={i} className="bg-surf1 rounded-lg px-3 py-2 border border-border">
                    <div className="flex justify-between items-center">
                      <span className="text-[10px] text-gray truncate max-w-[140px]">{p.site}</span>
                      <span className="text-[9px] text-algo border border-algo/30 rounded px-1">{p.proto}</span>
                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="text-xs font-semibold text-text">{p.amount}</span>
                      <span className="text-[9px] text-green-400">{p.time}</span>
                    </div>
                  </div>
                ))}
                <div className="text-center text-[10px] text-gray">
                  No phone interaction required
                </div>
              </div>
            </PopupShell>
          </div>

        </div>
      </div>
    </section>
  )
}
