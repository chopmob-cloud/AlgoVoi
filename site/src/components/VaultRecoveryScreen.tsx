import PopupShell from './PopupShell'

export default function VaultRecoveryScreen() {
  return (
    <section id="vault-recovery" className="py-24 px-6 relative overflow-hidden">
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#00C8FF18,transparent 70%)', left: '-80px', top: '80px' }} />
      <div className="absolute w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: 'radial-gradient(circle,#8B5CF618,transparent 70%)', right: '-80px', top: '140px' }} />

      <div className="max-w-6xl mx-auto flex flex-col lg:flex-row-reverse items-center gap-16 relative z-10">
        {/* Tagline */}
        <div className="flex-1 max-w-md">
          <div className="inline-flex items-center gap-2 bg-surf1 border border-border rounded-full px-4 py-1.5 text-xs text-gray mb-5">
            <span className="w-1.5 h-1.5 rounded-full bg-voi animate-pulse" />
            Non-custodial recovery · no seed phrase needed
          </div>
          <h2 className="text-4xl font-black leading-tight mb-4">
            Reconnect your<br />
            <span className="gradient-text-rev">existing vault</span>
          </h2>
          <p className="text-gray leading-relaxed mb-6">
            Reinstalled the extension or reconnected your wallet? Your vault contract
            lives on-chain forever. Enter the App ID to reconnect — a fresh agent key
            is generated and registered automatically via your owner wallet.
          </p>
          <div className="flex flex-col gap-3">
            {[
              { step: '1', label: 'Enter vault App ID', desc: 'Found in your previous install or transaction history' },
              { step: '2', label: 'Rotate agent key',   desc: 'New key generated locally and registered on-chain' },
              { step: '3', label: 'Auto-pay restored',  desc: 'Spending cap and balance unchanged — back in seconds' },
            ].map(s => (
              <div key={s.step} className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[10px] font-black text-[#0D1117]"
                  style={{ background: 'linear-gradient(135deg,#8B5CF6,#00C8FF)' }}>
                  {s.step}
                </div>
                <div>
                  <div className="text-xs font-bold text-text">{s.label}</div>
                  <div className="text-[10px] text-gray">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recovery panel mockup */}
        <PopupShell width="w-[380px]">
          {/* Header */}
          <div className="flex items-center gap-2.5 px-5 pt-5 pb-0">
            <div className="w-9 h-9 rounded-[10px] flex items-center justify-center text-sm"
              style={{ background: 'linear-gradient(135deg,#00C8FF,#8B5CF6)' }}>
              🔁
            </div>
            <div>
              <div className="text-sm font-bold">Reconnect Vault</div>
              <div className="text-[10px] text-gray mt-0.5">Link existing on-chain vault to this device</div>
            </div>
          </div>

          <div className="px-5 py-4 space-y-3">
            {/* App ID input */}
            <div>
              <div className="text-[10px] text-gray mb-1.5">Vault App ID</div>
              <div className="bg-surf1 border border-border rounded-xl px-3.5 py-2.5 flex items-center gap-2">
                <span className="text-xs font-mono text-text flex-1">3487338609</span>
                <span className="text-[9px] text-algo border border-algo/30 rounded px-1.5 py-0.5">Algorand</span>
              </div>
            </div>

            {/* Verified on-chain state */}
            <div className="bg-surf1 rounded-[10px] px-3.5 py-2.5 border border-border">
              <div className="text-[10px] text-gray mb-2">Verified on-chain</div>
              {[
                { label: 'Vault balance', value: '12.40 ALGO', color: '' },
                { label: 'Spending cap',  value: '5.00 ALGO',  color: '' },
                { label: 'Owner',         value: 'VPAB…7G3K',  color: '' },
                { label: 'Agent key',     value: 'Rotating…',  color: '#00C8FF' },
              ].map(r => (
                <div key={r.label} className="flex justify-between text-[10px] text-gray mb-1 last:mb-0">
                  <span>{r.label}</span>
                  <span className="font-semibold text-text" style={r.color ? { color: r.color } : {}}>
                    {r.value}
                  </span>
                </div>
              ))}
            </div>

            {/* New agent key preview */}
            <div className="bg-surf1 rounded-[10px] px-3.5 py-2.5 border border-border">
              <div className="text-[10px] text-gray mb-1.5">New agent key (generated)</div>
              <div className="text-xs font-mono font-semibold text-text">NEW7…QK4M</div>
              <div className="text-[9px] text-muted mt-1">Will be registered on-chain via WalletConnect owner signature</div>
            </div>

            <div className="text-[9px] text-muted text-center">
              Your balance and spending cap remain unchanged
            </div>
          </div>

          <div className="flex gap-2.5 px-5 pb-5">
            <button className="flex-1 py-2.5 rounded-xl bg-surf2 border border-border text-xs font-bold text-text">
              Cancel
            </button>
            <button className="flex-1 py-2.5 rounded-xl gradient-btn text-xs font-bold text-[#0D1117]">
              Reconnect Vault
            </button>
          </div>
        </PopupShell>
      </div>
    </section>
  )
}
