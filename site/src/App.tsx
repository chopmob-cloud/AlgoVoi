import Header from './components/Header'
import HeroSection from './components/HeroSection'
import WalletScreen from './components/WalletScreen'
import SendScreen from './components/SendScreen'
import SwapScreen from './components/SwapScreen'
import BuyScreen from './components/BuyScreen'
import VoiWalletScreen from './components/VoiWalletScreen'
import X402Screen from './components/X402Screen'
import X402ServiceSection from './components/X402ServiceSection'
import MppScreen from './components/MppScreen'
import AgentScreen from './components/AgentScreen'
import VaultScreen from './components/VaultScreen'
import GetStartedScreen from './components/GetStartedScreen'
import VaultRecoveryScreen from './components/VaultRecoveryScreen'
import EcommerceSection from './components/EcommerceSection'
import MultiTenantSection from './components/MultiTenantSection'
import SecuritySection from './components/SecuritySection'
import CTASection from './components/CTASection'
import Footer from './components/Footer'

export default function App() {
  return (
    <div className="min-h-screen bg-base text-text">
      <Header />
      <main>
        <HeroSection />

        {/* ── eCommerce + Transactional Security ── */}
        <EcommerceSection />
        <MultiTenantSection />
        <X402ServiceSection />
        <SecuritySection />

        {/* ── Extension + Tools & Services ── */}
        <X402Screen />
        <MppScreen />
        <AgentScreen />
        <WalletScreen />
        <SendScreen />
        <SwapScreen />
        <BuyScreen />
        <VoiWalletScreen />
        <VaultScreen />
        <GetStartedScreen />
        <VaultRecoveryScreen />
        <CTASection />
      </main>
      <Footer />
    </div>
  )
}
