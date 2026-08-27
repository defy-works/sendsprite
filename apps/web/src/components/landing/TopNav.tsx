import Link from "next/link";
import { Logo } from "@/components/ui/Logo";
import { GITHUB_URL } from "./Footer";

const LINK =
  "font-mono text-[11px] tracking-[0.2em] uppercase text-white/60 transition-colors duration-[var(--duration-fast)] hover:text-indigo-200";

export function TopNav() {
  return (
    <nav
      aria-label="Primary"
      className="flex items-center justify-between px-5 py-5 sm:px-12 lg:px-20"
    >
      <Link href="/" aria-label="Sendsprite">
        <Logo scale={2} />
      </Link>
      <ul className="flex items-center gap-6 sm:gap-8">
        <li className="hidden sm:block">
          <Link href="/docs" className={LINK}>
            Docs
          </Link>
        </li>
        <li className="hidden sm:block">
          <a href={GITHUB_URL} className={LINK}>
            GitHub
          </a>
        </li>
        <li>
          <Link
            href="/app"
            className="inline-flex h-9 items-center rounded-md border border-indigo-500 px-4 text-xs font-medium text-indigo-300 transition-colors duration-[var(--duration-fast)] hover:bg-indigo-500/15"
          >
            Dashboard
          </Link>
        </li>
      </ul>
    </nav>
  );
}
