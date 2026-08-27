"use client";
import NextLink from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface TabItem {
  href: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Matches this href and everything under it. Default: exact match. */
  prefix?: boolean;
}

/**
 * Route-backed tabs.
 *
 * `<Link>` rather than state, so a tab is a URL: the browser back button
 * works, a tab can be linked to from an email or a doc, and a server component
 * can do the data fetching for the tab that is actually open instead of the
 * page fetching all of them.
 */
export function Tabs({
  items,
  className,
  ariaLabel,
}: {
  items: readonly TabItem[];
  className?: string;
  ariaLabel: string;
}) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "-mx-1 flex gap-1 overflow-x-auto border-b border-white/10 pb-px",
        className,
      )}
    >
      {items.map((t) => {
        const active = t.prefix
          ? pathname === t.href || pathname.startsWith(`${t.href}/`)
          : pathname === t.href;
        return (
          <NextLink
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex shrink-0 items-center gap-2 rounded-t-md px-3 py-2.5 text-sm no-underline",
              "transition-colors duration-[var(--duration-fast)]",
              "after:absolute after:inset-x-2 after:-bottom-px after:h-px after:transition-colors",
              active
                ? "text-white after:bg-indigo-400"
                : "text-white/60 hover:bg-white/5 hover:text-white/90 after:bg-transparent",
            )}
          >
            {t.icon}
            {t.label}
          </NextLink>
        );
      })}
    </nav>
  );
}
