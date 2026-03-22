import PopupShell from './PopupShell'

export default function VaultScreen() {
  return (
    <section id="vault" className="py-24 px-6 bg-surf1/30 relative overflow-hidden">
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', left: '-100px', top: '60px' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', right: '-100px', top: '160px' }} />

      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row items-center gap-16 relative z-10">
        {/* Tagline */}
        <div className="flex-1 max-w-md">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-algo animate-pulse" />
            On-chain · AVM smart contract
          </div>
          <h2 className="text-4xl font-black leading-tight mb-4">
            Spending cap<br />
            <span className="gradient-text">vault</span>
          </h2>
          <p className="text-gray leading-relaxed mb-4">
            Deploy a smart contract vault with a spending cap. x402 and MPP
            micropayments flow automatically — the local agent key signs every
            transfer instantly with no phone interaction or WalletConnect relay.
          </p>
          <p className="text-gray leading-relaxed mb-6 text-sm">
            Supports ALGO, VOI, USDC, aUSDC and any ASA. Opt the vault into a
            token, fund it, and payments happen in sub-second — all enforced
            on-chain by the AVM contract.
          </p>
          <div className="flex flex-wrap gap-2">
            {['🤖 Local agent key', '🔒 On-chain spending cap', '⚡ No phone needed', '💱 ALGO + USDC + any ASA'].map(p => (
              <span key={p} className="bg-surf1 border border-border rounded-full px-3 py-1 text-xs text-gray">{p}</span>
            ))}
          </div>
        </div>

        {/* Vault panel mockup */}
        <PopupShell width="w-[380px]">
          {/* Header */}
          <div className="flex items-center gap-2.5 px-5 pt-5 pb-0">
            <div className="w-9 h-9 rounded-[10px] flex items-center justify-center text-sm"
              style={{ background: 'linear-gradient(135deg,#8B5CF6,#00C8FF)' }}>
              🔐
            </div>
            <div className="flex-1">
              <div className="text-sm font-bold">SpendingCap Vault</div>
              <div className="text-[10px] text-gray mt-0.5">Algorand Mainnet · App #3487338609</div>
            </div>
            <button className="text-[10px] text-algo border border-algo/30 bg-algo/10 rounded px-2 py-1 font-semibold">
              Copy ID
            </button>
          </div>

          <div className="px-5 py-4 space-y-3">
            {/* Balance + cap */}
            <div className="rounded-xl p-4 border"
              style={{ background: 'linear-gradient(135deg,#8B5CF611,#00C8FF11)', borderColor: '#8B5CF633' }}>
              <div className="flex justify-between mb-3">
                <div>
                  <div className="text-[10px] text-gray mb-0.5">Vault balance</div>
                  <div className="text-2xl font-black gradient-text">12.40 ALGO</div>
                </div>
                <div className="text-right">
                  <div className="text-[10px] text-gray mb-0.5">Spending cap</div>
                  <div className="text-2xl font-black text-text">5.00</div>
                </div>
              </div>
              {/* Cap bar */}
              <div className="w-full h-1.5 rounded-full bg-surf2 overflow-hidden">
                <div className="h-full rounded-full" style={{ width: '38%', background: 'linear-gradient(90deg,#8B5CF6,#00C8FF)' }} />
              </div>
              <div className="flex justify-between text-[9px] text-muted mt-1">
                <span>1.90 ALGO used</span>
                <span>3.10 remaining</span>
              </div>
            </div>

            {/* Agent key */}
            <div className="bg-surf1 rounded-[10px] px-3.5 py-2.5 border border-border">
              <div className="flex justify-between items-center">
                <div>
                  <div className="text-[10px] text-gray mb-0.5">Agent key</div>
                  <div className="text-xs font-mono font-semibold">AGT3…X9QK</div>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
                  <span className="text-[10px] text-green-400 font-semibold">Registered</span>
                </div>
              </div>
            </div>

            {/* Recent auto-pays */}
            <div className="bg-surf1 rounded-[10px] px-3.5 py-2.5 border border-border">
              <div className="text-[10px] text-gray mb-2">Recent auto-payments</div>
              {[
                { site: 'x402.ilovechicken.co.uk', amount: '0.25 USDC', proto: 'x402' },
                { site: 'api.merchant.io',          amount: '0.50 ALGO', proto: 'MPP' },
                { site: 'data.apiservice.com',      amount: '0.10 USDC', proto: 'x402' },
              ].map((p, i) => (
                <div key={i} className="flex justify-between items-center text-[10px] mb-1 last:mb-0">
                  <span className="text-gray truncate max-w-[180px]">{p.site}</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-text font-semibold">{p.amount}</span>
                    <span className="text-[9px] text-algo border border-algo/30 rounded px-1">{p.proto}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex gap-2.5 px-5 pb-5">
            <button className="flex-1 py-2 rounded-xl bg-surf2 border border-border text-xs font-bold text-gray">
              Adjust Cap
            </button>
            <button className="flex-1 py-2 rounded-xl gradient-btn text-xs font-bold text-[#0D1117]">
              Fund Vault
            </button>
          </div>
        </PopupShell>
      </div>
    </section>
  )
}
