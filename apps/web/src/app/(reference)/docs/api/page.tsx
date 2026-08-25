import type { Metadata } from "next";
import Link from "next/link";
import { ApiReference } from "./reference";

export const metadata: Metadata = {
  title: "Sendsprite API reference",
  description:
    "Every endpoint of the Sendsprite REST API, generated from this instance's own OpenAPI document.",
};

/**
 * `/docs/api` — the interactive API reference.
 *
 * It lives in the `(reference)` route group rather than under `app/docs/`
 * because Scalar renders a full-viewport application with its own sidebar and
 * CSS reset: the prose column and sidebar of `app/docs/layout.tsx` would fight
 * it. The bar below is therefore the only way back into the docs.
 */
export default function ApiReferencePage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 bg-ink/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3 sm:px-8">
          <div className="flex items-baseline gap-4">
            <Link
              href="/docs"
              className="font-mono text-[11px] tracking-[0.2em] uppercase text-white/60 transition-colors duration-[var(--duration-fast)] hover:text-indigo-200"
            >
              &larr; Docs
            </Link>
            <span className="num-stamp">API reference</span>
          </div>
          <Link
            href="/api/v1/openapi.json"
            prefetch={false}
            className="font-mono text-[11px] tracking-[0.2em] uppercase text-white/60 transition-colors duration-[var(--duration-fast)] hover:text-indigo-200"
          >
            openapi.json
          </Link>
        </div>
        <div className="hairline" aria-hidden />
      </header>

      <main className="flex-1">
        <h1 className="sr-only">Sendsprite API reference</h1>
        <ApiReference />
      </main>
    </div>
  );
}
