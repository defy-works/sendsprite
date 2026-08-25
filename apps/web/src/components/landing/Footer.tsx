import Link from "next/link";

export const GITHUB_URL = "https://github.com/defy-works/sendsprite";

const LINK =
  "transition-colors duration-[var(--duration-fast)] hover:text-indigo-200";

export function Footer() {
  return (
    <footer className="px-5 pt-16 pb-10 sm:px-12 lg:px-20">
      <div className="mx-auto max-w-7xl">
        <div className="hairline" aria-hidden />
        <div className="flex flex-col gap-8 pt-8 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-col gap-3">
            <p className="font-display text-xl font-bold tracking-[-0.03em]">
              Sendsprite
            </p>
            <p className="font-mono text-[11px] tracking-[0.08em] text-white/40">
              AGPL server, MIT SDK. Self-host it, fork it, ship it.
            </p>
          </div>
          <nav aria-label="Footer">
            <ul className="flex flex-wrap gap-x-8 gap-y-3 font-mono text-[11px] tracking-[0.2em] text-white/60 uppercase">
              <li>
                <a href={GITHUB_URL} className={LINK}>
                  GitHub
                </a>
              </li>
              <li>
                <Link href="/docs" className={LINK}>
                  Docs
                </Link>
              </li>
              <li>
                <a href={`${GITHUB_URL}#licensing`} className={LINK}>
                  Licensing
                </a>
              </li>
              <li>
                <a href="https://defy.works" className={LINK}>
                  Built by defy.works
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </div>
    </footer>
  );
}
