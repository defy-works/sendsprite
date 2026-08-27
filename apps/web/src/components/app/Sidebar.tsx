"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { IconChevronLeft, IconChevronRight } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { NAV_GROUPS, type NavChild, type NavItem } from "./nav";
import { NavLink } from "./NavLink";
import { railWidth, useShell } from "./ShellState";

/**
 * The section rail: full height, its own scrollbar, and it does not move with
 * the page.
 *
 * It used to be a flex child as tall as the document, so a long page made the
 * sidebar long too and its foot scrolled away with the content. A navigation
 * column that leaves the screen is not navigation. The shell is now a fixed
 * viewport (`h-dvh`, no page scroll) and this column and the main column each
 * scroll themselves.
 *
 * Collapsed it is a 60px strip of icons — the same arrangement Cloudflare's
 * console uses, and for the same reason: rows keep their order and position
 * across the toggle, so muscle memory survives it.
 */
export function Sidebar({
  settingsChildren,
}: {
  settingsChildren?: readonly NavChild[];
}) {
  const { collapsed, toggle, ready } = useShell();
  return (
    <aside
      className={cn(
        "hidden min-h-0 shrink-0 flex-col border-r border-white/10 md:flex",
        ready && "transition-[width] duration-[var(--duration-normal)]",
        railWidth(collapsed),
      )}
    >
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
        <SidebarNav collapsed={collapsed} settingsChildren={settingsChildren} />
      </div>
      {/* Same height and the same top border as the footer in the main column,
          so the two rules read as one line across the bottom of the window. */}
      <div className="flex h-12 shrink-0 items-center border-t border-white/5 px-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          className={cn(
            "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm text-white/45",
            "transition-colors hover:bg-white/5 hover:text-white/80",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? (
            <IconChevronRight className="text-base" />
          ) : (
            <>
              <IconChevronLeft className="text-base" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

/**
 * The rows, also used inside the mobile drawer — where nothing is ever
 * collapsed, because a drawer that opens to a strip of unlabelled icons helps
 * nobody.
 */
export function SidebarNav({
  collapsed = false,
  settingsChildren,
}: {
  collapsed?: boolean;
  settingsChildren?: readonly NavChild[];
}) {
  return (
    <nav className="flex flex-col gap-4" aria-label="Sections">
      {NAV_GROUPS.map((g) => (
        <div key={g.label ?? "root"} className="flex flex-col gap-0.5">
          {g.rule && (
            <div
              aria-hidden
              className={cn(
                "mb-2 h-px bg-white/10",
                collapsed ? "mx-auto w-5" : "mx-3",
              )}
            />
          )}
          {g.label &&
            (collapsed ? (
              // A rule instead of a heading: the group boundary is worth
              // keeping when the words are not.
              <div
                aria-hidden
                className="mx-auto my-1.5 h-px w-5 bg-white/10"
              />
            ) : (
              <p className="num-stamp px-3 pb-1.5">{g.label}</p>
            ))}
          {g.items.map((n) => (
            <Row
              key={n.href}
              item={
                n.href === "/app/settings" && settingsChildren
                  ? { ...n, children: settingsChildren }
                  : n
              }
              collapsed={collapsed}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}

/** One row, plus its children when it has them and there is room for them. */
function Row({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const pathname = usePathname();
  const onSection = pathname.startsWith(item.href);
  const kids = item.children ?? [];
  const nested = kids.length > 0 && !collapsed;

  // Open when you are on the page the rows belong to, and openable by hand
  // otherwise — the same behaviour as the console this borrows from. Tracked
  // separately from the route so navigating to Settings opens it without
  // trapping it open once you leave.
  const [open, setOpen] = useState(onSection);
  useEffect(() => {
    if (onSection) setOpen(true);
  }, [onSection]);

  if (!nested) return <NavLink {...item} collapsed={collapsed} />;

  return (
    <div className="flex flex-col">
      <NavLink
        {...item}
        expanded={open}
        onToggle={() => setOpen((v) => !v)}
        suppressActive={kids.some((c) => c.href === pathname)}
      />
      {open && (
        // One rule down the whole list, not a border per row. Per-row borders
        // rendered as a stack of short ticks — each row's rounded corners cut
        // its own segment — which read as punctuation rather than as a group.
        <ul className="mt-1 ml-[21px] flex flex-col gap-0.5 border-l border-white/12 pl-2">
          {kids.map((c) => (
            <li key={c.href}>
              <SubLink {...c} current={pathname === c.href} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * A child row.
 *
 * No icon: these are pages of one section, not destinations of their own, and
 * a column of icons at two levels reads as two menus. The current one is a
 * filled row like the section headers are — it had no highlight at all, so on
 * a settings page nothing in the sidebar said which one you were reading.
 */
function SubLink({ href, label, current }: NavChild & { current: boolean }) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={cn(
        "block rounded-md px-2.5 py-1.5 text-[13px] no-underline",
        "transition-colors duration-[var(--duration-fast)]",
        current
          ? "bg-white/8 text-white"
          : "text-white/50 hover:bg-white/4 hover:text-white",
      )}
    >
      {label}
    </Link>
  );
}
