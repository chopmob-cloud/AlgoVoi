export default function Footer() {
  return (
    <footer className="border-t border-border px-6 py-8 text-center text-xs text-gray">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded gradient-btn flex items-center justify-center text-[8px] font-black text-[#0D1117]">AV</div>
          <span className="font-semibold text-text">AlgoVoi</span>
          <span className="text-muted">— Web3 wallet for Algorand &amp; Voi</span>
        </div>
        <div className="flex gap-4">
          <a href="https://github.com/chopmob-cloud/AlgoVoi" target="_blank" rel="noopener noreferrer"
            className="hover:text-text transition-colors">GitHub</a>
          <a href="/AlgoVoi/privacy-policy.html" className="hover:text-text transition-colors">Privacy Policy</a>
        </div>
      </div>
    </footer>
  )
}
