"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { IconChevronDown } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

export function NavLink({
  href,
  label,
  icon,
  collapsed = false,
  expanded,
  onToggle,
  suppressActive = false,
}: {
  href: string;
  label: string;
  icon?: ReactNode;
  /** Icon only, with the label as a tooltip and to screen readers. */
  collapsed?: boolean;
  /**
   * Set when this row has children. The chevron is a separate button, not the
   * row: the row still navigates, so opening the section and going to it stay
   * two different intentions.
   */
  expanded?: boolean;
  onToggle?: () => void;
  /**
   * Drop the active fill even when the route matches.
   *
   * Set when one of this row's children is the current page: the child carries
   * the highlight, and filling the parent as well marks two rows as "here".
   */
  suppressActive?: boolean;
}) {
  const pathname = usePathname();
  // `/app` matches only itself; everything else owns its subtree. Compared
  // against a trailing slash so `/app/api-keys` does not light up a
  // hypothetical `/app/api` row.
  const active =
    !suppressActive &&
    (pathname === href || (href !== "/app" && pathname.startsWith(`${href}/`)));
  const link = (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      // Collapsed, the row has no text, so the accessible name has to come
      // from somewhere; `title` alone is not one a screen reader announces
      // reliably.
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm no-underline",
        collapsed && "justify-center px-0",
        onToggle && "pr-9",
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
      {!collapsed && label}
    </Link>
  );

  if (onToggle === undefined) return link;
  return (
    <div className="group/row relative flex items-center">
      <div className="min-w-0 flex-1">{link}</div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        className={cn(
          "absolute right-1.5 grid h-6 w-6 place-items-center rounded",
          "text-white/35 transition-colors hover:bg-white/8 hover:text-white",
        )}
      >
        {/* Closed points right, open points down — the direction the section
            will move, not the direction it came from. */}
        <IconChevronDown
          className={cn(
            "text-xs transition-transform duration-[var(--duration-fast)]",
            !expanded && "-rotate-90",
          )}
        />
      </button>
    </div>
  );
}
