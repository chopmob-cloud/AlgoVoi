import Header from './components/Header'
import HeroSection from './components/HeroSection'
import WalletScreen from './components/WalletScreen'
import SendScreen from './components/SendScreen'
import SwapScreen from './components/SwapScreen'
import VoiWalletScreen from './components/VoiWalletScreen'
import X402Screen from './components/X402Screen'
import MppScreen from './components/MppScreen'
import AgentScreen from './components/AgentScreen'
import VaultScreen from './components/VaultScreen'
import VaultRecoveryScreen from './components/VaultRecoveryScreen'
import MultiTenantSection from './components/MultiTenantSection'
import CTASection from './components/CTASection'
import Footer from './components/Footer'

export default function App() {
  return (
    <div className="min-h-screen bg-base text-text">
      <Header />
      <main>
        <HeroSection />
        <WalletScreen />
        <SendScreen />
        <SwapScreen />
        <VoiWalletScreen />
        <X402Screen />
        <MppScreen />
        <AgentScreen />
        <VaultScreen />
        <VaultRecoveryScreen />
        <MultiTenantSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  )
}
