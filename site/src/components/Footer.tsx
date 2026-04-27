export default function Footer() {
  return (
    <footer className="border-t border-border px-4 sm:px-6 py-8 text-center text-xs text-gray">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 sm:gap-3">
        <div className="flex items-center gap-2 flex-wrap justify-center">
          <div className="w-5 h-5 rounded gradient-btn flex items-center justify-center text-[8px] font-black text-[#0D1117]">AV</div>
          <span className="font-semibold text-text">AlgoVoi</span>
          <span className="text-muted">— Web3 wallet for Algorand &amp; Voi</span>
        </div>
        <div className="flex flex-wrap justify-center gap-x-3 gap-y-2 sm:gap-4">
          <a href="https://chromewebstore.google.com/detail/algovoi/ofmgegnkjdmbeakjbmfaagigmhagdcbl" target="_blank" rel="noopener noreferrer"
            className="hover:text-text transition-colors">Chrome</a>
          <a href="https://addons.mozilla.org/en-GB/firefox/addon/algovoi/" target="_blank" rel="noopener noreferrer"
            className="hover:text-text transition-colors">Firefox</a>
          <a href="https://github.com/chopmob-cloud/AlgoVoi" target="_blank" rel="noopener noreferrer"
            className="hover:text-text transition-colors">GitHub</a>
          <a href="https://x402.ilovechicken.co.uk" target="_blank" rel="noopener noreferrer"
            className="hover:text-text transition-colors">x402 Demo</a>
          <a href="/AlgoVoi/privacy-policy.html"
            className="hover:text-text transition-colors">Privacy Policy</a>
          <a href="/AlgoVoi/compliance.html" className="hover:text-text transition-colors">Compliance</a>
          <a href="/AlgoVoi/terms.html" className="hover:text-text transition-colors">Terms</a>
        </div>
      </div>
    </footer>
  )
}
