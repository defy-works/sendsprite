"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function NavLink({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon?: ReactNode;
}) {
  const pathname = usePathname();
  // `/app` matches only itself; everything else owns its subtree. Compared
  // against a trailing slash so `/app/api-keys` does not light up a
  // hypothetical `/app/api` row.
  const active =
    pathname === href || (href !== "/app" && pathname.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm no-underline",
        "transition-colors duration-[var(--duration-fast)]",
        // The active marker is a rail on the left rather than a filled pill:
        // ten filled pills in one column is a lot of weight for one of them
        // to be the current page.
        "before:absolute before:top-1.5 before:bottom-1.5 before:-left-1 before:w-0.5 before:rounded-full",
        "before:transition-all before:duration-[var(--duration-normal)] before:ease-[var(--ease-out-soft)]",
        active
          ? "bg-white/6 text-white before:bg-indigo-400"
          : "text-white/65 before:scale-y-0 before:bg-transparent hover:bg-white/4 hover:text-white",
      )}
    >
      <span
        className={cn(
          "text-base transition-colors",
          active
            ? "text-indigo-300"
            : "text-white/40 group-hover:text-white/70",
        )}
      >
        {icon}
      </span>
      {label}
    </Link>
  );
}
