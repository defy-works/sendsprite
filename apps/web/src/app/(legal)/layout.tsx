import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

export const metadata: Metadata = {
  title: { default: "Legal", template: "%s · Sendsprite" },
  description:
    "Terms of Service and Privacy Policy for the hosted Sendsprite service, and the MIT licence the software is under.",
};

const TOP_LINK =
  "font-mono text-[11px] tracking-[0.2em] uppercase text-white/60 transition-colors duration-[var(--duration-fast)] hover:text-indigo-200";

/**
 * `/terms`, `/privacy` and `/license`. Same header and prose column as `/docs`, without
 * the docs sidebar: these pages are not product documentation and must not
 * show up in the reading order of `DOCS_NAV`.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#legal-main" className="skip-link">
        Skip to content
      </a>
      <header className="sticky top-0 z-20 bg-ink/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
          <div className="flex items-baseline gap-4">
            <Link
              href="/"
              className="font-display text-base font-bold tracking-[-0.02em] text-white"
            >
              Sendsprite
            </Link>
            <span className="num-stamp">Legal</span>
          </div>
          <nav aria-label="Legal" className="flex items-center gap-6">
            <Link href="/terms" className={TOP_LINK}>
              Terms
            </Link>
            <Link href="/privacy" className={TOP_LINK}>
              Privacy
            </Link>
            <Link href="/license" className={TOP_LINK}>
              Licence
            </Link>
            <Link href="/docs" className={`hidden sm:block ${TOP_LINK}`}>
              Docs
            </Link>
          </nav>
        </div>
        <div className="hairline" aria-hidden />
      </header>

      <main
        id="legal-main"
        className="mx-auto max-w-6xl px-5 py-8 sm:px-8 md:py-14"
      >
        <article className="max-w-[72ch]">{children}</article>
      </main>
    </>
  );
}
