import { useState } from 'react'

const NAV_LINKS = [
  // eCommerce + Transactional Security
  { href: '#ecommerce',    label: 'eCommerce' },
  { href: '#platform',     label: 'Platform' },
  { href: '#x402-service', label: 'x402 API' },
  { href: '#security',     label: 'Security' },
  // Extension + Tools & Services
  { href: '#x402',         label: 'x402' },
  { href: '#mpp',          label: 'MPP' },
  { href: '#agents',       label: 'AI Agents' },
  { href: '#wallet',       label: 'Wallet' },
  { href: '#swap',         label: 'Swap' },
  { href: '#get-started',  label: 'Setup' },
]

export default function Header() {
  const [open, setOpen] = useState(false)

  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/50 bg-base/80 backdrop-blur-md">
      <div className="flex items-center justify-between px-6 py-4">
        {/* Logo */}
        <a href="#" className="flex items-center gap-2" onClick={() => setOpen(false)}>
          <div className="w-7 h-7 rounded-lg gradient-btn flex items-center justify-center text-base font-black text-[#0D1117] text-xs">
            AV
          </div>
          <span className="font-bold text-sm text-text">AlgoVoi</span>
        </a>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-6 text-sm text-gray">
          {NAV_LINKS.map(l => (
            <a key={l.href} href={l.href} className="hover:text-text transition-colors">{l.label}</a>
          ))}
        </nav>

        {/* Desktop CTA buttons */}
        <div className="hidden sm:flex items-center gap-2">
          <a
            href="https://chromewebstore.google.com/detail/algovoi/ofmgegnkjdmbeakjbmfaagigmhagdcbl"
            target="_blank"
            rel="noopener noreferrer"
            className="gradient-btn text-[#0D1117] text-xs font-bold px-4 py-2 rounded-lg"
          >
            Add to Chrome
          </a>
          <a
            href="https://addons.mozilla.org/en-GB/firefox/addon/algovoi/"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-surf1 border border-border text-text text-xs font-bold px-4 py-2 rounded-lg hover:bg-surf2 transition-colors"
          >
            Add to Firefox
          </a>
        </div>

        {/* Mobile: Chrome button + hamburger */}
        <div className="flex sm:hidden items-center gap-2">
          <a
            href="https://chromewebstore.google.com/detail/algovoi/ofmgegnkjdmbeakjbmfaagigmhagdcbl"
            target="_blank"
            rel="noopener noreferrer"
            className="gradient-btn text-[#0D1117] text-xs font-bold px-3 py-2 rounded-lg"
          >
            Chrome
          </a>
          <button
            onClick={() => setOpen(o => !o)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="w-9 h-9 flex flex-col items-center justify-center gap-1.5 rounded-lg border border-border bg-surf1 hover:bg-surf2 transition-colors"
          >
            <span className={`block w-4.5 h-0.5 bg-text rounded transition-transform duration-200 ${open ? 'translate-y-2 rotate-45' : ''}`} style={{ width: '18px' }} />
            <span className={`block h-0.5 bg-text rounded transition-opacity duration-200 ${open ? 'opacity-0' : ''}`} style={{ width: '18px' }} />
            <span className={`block h-0.5 bg-text rounded transition-transform duration-200 ${open ? '-translate-y-2 -rotate-45' : ''}`} style={{ width: '18px' }} />
          </button>
        </div>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="sm:hidden border-t border-border bg-base/95 backdrop-blur-md px-6 py-4 flex flex-col gap-1">
          {NAV_LINKS.map(l => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className="text-sm text-gray hover:text-text py-2.5 border-b border-border/40 last:border-0 transition-colors"
            >
              {l.label}
            </a>
          ))}
          <div className="flex flex-col gap-2 pt-3">
            <a
              href="https://chromewebstore.google.com/detail/algovoi/ofmgegnkjdmbeakjbmfaagigmhagdcbl"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="gradient-btn text-[#0D1117] text-sm font-bold px-4 py-3 rounded-xl text-center"
            >
              Add to Chrome — Free
            </a>
            <a
              href="https://addons.mozilla.org/en-GB/firefox/addon/algovoi/"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="bg-surf1 border border-border text-text text-sm font-bold px-4 py-3 rounded-xl text-center hover:bg-surf2 transition-colors"
            >
              Add to Firefox — Free
            </a>
          </div>
        </div>
      )}
    </header>
  )
}
