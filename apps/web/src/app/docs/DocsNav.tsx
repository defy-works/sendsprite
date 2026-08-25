"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { DOCS_NAV } from "./nav";

/**
 * The docs index. Rendered twice by the layout — as the desktop sidebar and
 * inside the mobile `<details>` — so each instance gets its own accessible
 * name to keep them apart.
 */
export function DocsNav({ label }: { label: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="flex flex-col">
        {DOCS_NAV.map((item, i) => {
          const active = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-baseline gap-3 border-l-2 py-2 pl-4 text-sm transition-colors duration-[var(--duration-fast)]",
                  active
                    ? "border-indigo-400 text-white"
                    : "border-white/10 text-white/55 hover:border-indigo-400/50 hover:text-indigo-200",
                )}
              >
                <span
                  aria-hidden
                  className="font-mono text-[10px] tracking-[0.16em] text-white/30"
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                {item.title}
                {item.soon && (
                  <span className="font-mono text-[10px] tracking-[0.16em] text-indigo-300/60 uppercase">
                    soon
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
