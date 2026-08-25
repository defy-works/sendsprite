import Link from "next/link";
import { InstallCommand } from "./InstallCommand";

const CTA_BASE =
  "inline-flex h-12 items-center justify-center gap-3 rounded-md px-6 text-sm font-medium " +
  "tracking-wide transition-colors duration-[var(--duration-fast)]";

export function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="relative overflow-hidden px-5 pt-20 pb-16 sm:px-12 sm:pt-28 sm:pb-24 lg:px-20 lg:pt-36"
    >
      <div
        aria-hidden
        className="grid-hairlines pointer-events-none absolute inset-0 opacity-70"
      />
      <div className="relative z-10 mx-auto max-w-7xl">
        <p className="num-stamp rise-in">01 — Self-hosted</p>
        <h1
          id="hero-title"
          className="metric-xl rise-in mt-8 max-w-4xl text-white"
          style={{
            animationDelay: "80ms",
            fontSize: "clamp(2.75rem, 8vw, 7rem)",
            lineHeight: 0.92,
          }}
        >
          The email API
          <br />
          you run <span className="text-indigo-300 italic">yourself.</span>
        </h1>

        <div
          className="rise-in mt-12 grid gap-10 lg:grid-cols-[1fr_1.15fr] lg:items-end lg:gap-20"
          style={{ animationDelay: "200ms" }}
        >
          <div className="flex min-w-0 flex-col gap-8">
            <p className="max-w-md text-base leading-relaxed text-white/75">
              Amazon SES under the hood. One container, one command. Your
              domains, your data.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/app"
                className={`${CTA_BASE} bg-indigo-500 text-white hover:bg-indigo-400 active:bg-indigo-600`}
              >
                Open dashboard
                <span aria-hidden className="font-mono text-xs">
                  →
                </span>
              </Link>
              <Link
                href="/docs"
                className={`${CTA_BASE} border border-white/20 text-white/85 hover:border-indigo-400/70 hover:bg-indigo-500/10 hover:text-indigo-200`}
              >
                Read the docs
              </Link>
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <p className="num-stamp">Install</p>
            <InstallCommand />
            <p className="font-mono text-[11px] tracking-[0.08em] text-white/40">
              Docker + Postgres. Prompts for a domain, brings up the container,
              opens the setup wizard.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
