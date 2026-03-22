export default function CTASection() {
  return (
    <section className="py-32 px-6 text-center relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at 50% 50%,#00C8FF0A,transparent 70%)' }} />

      <div className="relative z-10 max-w-xl mx-auto">
        <h2 className="text-4xl md:text-5xl font-black mb-4">
          Ready to pay the web<br />
          <span className="gradient-text">with crypto?</span>
        </h2>
        <p className="text-gray mb-8 leading-relaxed">
          AlgoVoi is free, open source, and built for the future of on-chain micropayments.
          Install in seconds.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a
            href="https://chromewebstore.google.com/detail/algovoi/ofmgegnkjdmbeakjbmfaagigmhagdcbl"
            target="_blank"
            rel="noopener noreferrer"
            className="gradient-btn text-[#0D1117] font-bold px-8 py-3 rounded-xl text-sm"
          >
            Add to Chrome — Free
          </a>
          <a
            href="https://github.com/chopmob-cloud/AlgoVoi"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-surf1 border border-border text-text font-bold px-8 py-3 rounded-xl text-sm hover:bg-surf2 transition-colors"
          >
            View Source
          </a>
        </div>
      </div>
    </section>
  )
}
