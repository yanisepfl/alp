const stats = [
  { label: "TVL", value: "—" },
  { label: "Share price", value: "—" },
  { label: "Position", value: "—" },
  { label: "Vault age", value: "—" },
];

export default function AppPage() {
  return (
    <main className="relative min-h-dvh w-full">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-veil bg-obsidian/95 px-6 backdrop-blur">
        <div className="flex items-center gap-2">
          <div
            aria-hidden
            className="h-6 w-6"
            style={{
              backgroundColor: "#fff",
              WebkitMaskImage: "url(/logo.png)",
              maskImage: "url(/logo.png)",
              WebkitMaskSize: "contain",
              maskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskPosition: "center",
            }}
          />
          <span
            style={{
              color: "#fff",
              fontFamily: "var(--font-radley)",
              fontSize: "22px",
              lineHeight: 1,
              fontWeight: 400,
              letterSpacing: "-0.02em",
            }}
          >
            alps
          </span>
        </div>
        <button
          type="button"
          data-magnet
          className="rounded-full border border-veil px-4 py-1.5 text-sm text-mist transition-colors hover:bg-white/5"
        >
          Connect
        </button>
      </header>

      <section className="mx-auto max-w-3xl px-6 pt-14 pb-10">
        <div className="grid grid-cols-4 divide-x divide-veil">
          {stats.map((stat) => (
            <div key={stat.label} className="px-6 first:pl-0 last:pr-0">
              <div className="text-[11px] uppercase tracking-wider text-haze">
                {stat.label}
              </div>
              <div
                className="mt-2 text-2xl text-mist"
                style={{ fontFamily: "var(--font-radley)" }}
              >
                {stat.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-md px-6">
        <div className="rounded-2xl border border-veil p-6">
          <div className="flex items-center gap-6 border-b border-veil pb-4">
            <button
              type="button"
              data-magnet
              className="relative pb-1 text-sm text-mist after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-mist"
            >
              Deposit
            </button>
            <button
              type="button"
              data-magnet
              className="pb-1 text-sm text-haze transition-colors hover:text-mist"
            >
              Redeem
            </button>
          </div>

          <div className="mt-6">
            <div className="flex items-center justify-between text-xs text-haze">
              <span>Amount</span>
              <span>Balance: — USDC</span>
            </div>
            <div className="mt-2 flex items-center gap-3 rounded-xl border border-veil px-4 py-3">
              <input
                inputMode="decimal"
                placeholder="0.00"
                className="flex-1 bg-transparent text-2xl text-mist outline-none placeholder:text-haze"
                style={{ fontFamily: "var(--font-radley)" }}
              />
              <button
                type="button"
                data-magnet
                className="text-xs text-haze transition-colors hover:text-mist"
              >
                MAX
              </button>
              <span className="text-sm text-haze">USDC</span>
            </div>
            <div className="mt-3 text-xs text-haze">You receive ≈ — ALP</div>
          </div>

          <button
            type="button"
            data-magnet
            className="mt-6 w-full rounded-xl bg-white py-3 text-sm font-medium text-obsidian transition-colors hover:bg-mist"
          >
            Deposit
          </button>
        </div>
      </section>

      <footer className="mx-auto max-w-md px-6 pt-10 pb-12 text-center text-xs text-haze">
        <a data-magnet href="#" className="transition-colors hover:text-mist">
          Vault: 0x…
        </a>
        <span className="mx-2">·</span>
        <a data-magnet href="#" className="transition-colors hover:text-mist">
          Audited build
        </a>
      </footer>
    </main>
  );
}
