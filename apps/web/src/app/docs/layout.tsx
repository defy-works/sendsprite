import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { DocsNav } from "./DocsNav";

export const metadata: Metadata = {
  title: { default: "Docs", template: "%s · Sendsprite docs" },
  description: "How to run, configure and send with a Sendsprite instance.",
};

const TOP_LINK =
  "font-mono text-[11px] tracking-[0.2em] uppercase text-white/60 transition-colors duration-[var(--duration-fast)] hover:text-indigo-200";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <a href="#docs-main" className="skip-link">
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
            <span className="num-stamp">Docs</span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/docs/api" className={`hidden sm:block ${TOP_LINK}`}>
              API
            </Link>
            <Link
              href="/app"
              className="inline-flex h-9 items-center rounded-md border border-indigo-500 px-4 text-xs font-medium text-indigo-300 transition-colors duration-[var(--duration-fast)] hover:bg-indigo-500/15"
            >
              Dashboard
            </Link>
          </div>
        </div>
        <div className="hairline" aria-hidden />
      </header>

      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-8 sm:px-8 md:flex-row md:gap-14 md:py-14">
        {/* Under md the index collapses into a disclosure above the page. */}
        <details className="glass rounded-md px-4 py-3 md:hidden">
          <summary className="num-stamp cursor-pointer list-none">
            Contents
          </summary>
          <div className="pt-3">
            <DocsNav label="Docs (compact)" />
          </div>
        </details>

        <aside className="hidden w-56 shrink-0 md:block">
          <div className="sticky top-24">
            <p className="num-stamp mb-4 pl-4">Contents</p>
            <DocsNav label="Docs" />
          </div>
        </aside>

        <main id="docs-main" className="min-w-0 flex-1">
          <article className="max-w-[72ch]">{children}</article>
        </main>
      </div>
    </>
  );
}
