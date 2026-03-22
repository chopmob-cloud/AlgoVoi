export default function Header() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-6 py-4 border-b border-border/50 bg-base/80 backdrop-blur-md">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg gradient-btn flex items-center justify-center text-base font-black text-[#0D1117] text-xs">
          AV
        </div>
        <span className="font-bold text-sm text-text">AlgoVoi</span>
      </div>
      <nav className="hidden md:flex items-center gap-6 text-sm text-gray">
        <a href="#wallet" className="hover:text-text transition-colors">Wallet</a>
        <a href="#send" className="hover:text-text transition-colors">Send</a>
        <a href="#swap" className="hover:text-text transition-colors">Swap</a>
        <a href="#x402" className="hover:text-text transition-colors">x402</a>
        <a href="#mpp" className="hover:text-text transition-colors">MPP</a>
        <a href="#agents" className="hover:text-text transition-colors">AI Agents</a>
        <a href="#get-started" className="hover:text-text transition-colors">Setup</a>
        <a href="#multitenant" className="text-voi font-semibold hover:text-text transition-colors">Platform</a>
      </nav>
      <a
        href="https://chromewebstore.google.com/detail/algovoi/ofmgegnkjdmbeakjbmfaagigmhagdcbl"
        target="_blank"
        rel="noopener noreferrer"
        className="gradient-btn text-[#0D1117] text-xs font-bold px-4 py-2 rounded-lg"
      >
        Add to Chrome
      </a>
    </header>
  )
}
