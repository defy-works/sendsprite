"use client";
import { useEffect, useState } from "react";
import { IconChevronLeft } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { NAV_GROUPS } from "./nav";
import { NavLink } from "./NavLink";

const KEY = "sendsprite:sidebar-collapsed";

/**
 * The section rail.
 *
 * Collapsible, and it remembers: this is a console people keep open beside a
 * terminal or a Cloudflare tab, and on a 13" screen 240px of mostly-whitespace
 * column is worth reclaiming. Collapsed it is a 60px strip of icons with the
 * label as a tooltip, which is the arrangement Cloudflare's own console uses
 * and for the same reason — the rows stay in the same order and the same
 * place, so muscle memory survives the toggle.
 *
 * The preference lives in `localStorage`, per browser. It is a viewing
 * preference, not account state: syncing it to the server would mean a write
 * on every toggle and a layout that changes under you on another machine.
 *
 * It renders expanded on the first paint and corrects after mount, because a
 * server render cannot know what the browser stored. The correction is not
 * animated — a sidebar that slides shut on every page load looks broken.
 */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(KEY) === "1");
    } catch {
      // A browser with site data blocked still gets a working sidebar.
    }
    setReady(true);
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      // Same: the preference is lost, the sidebar is not.
    }
  };

  return (
    <aside
      className={cn(
        "hidden shrink-0 flex-col border-r border-white/10 md:flex",
        ready && "transition-[width] duration-[var(--duration-normal)]",
        collapsed ? "w-[60px]" : "w-60",
      )}
    >
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
        <SidebarNav collapsed={collapsed} />
      </div>
      <div className="shrink-0 border-t border-white/5 p-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={collapsed}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-white/45",
            "transition-colors hover:bg-white/5 hover:text-white/80",
            collapsed && "justify-center px-0",
          )}
        >
          <IconChevronLeft
            className={cn(
              "text-base transition-transform duration-[var(--duration-normal)]",
              collapsed && "rotate-180",
            )}
          />
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </aside>
  );
}

/**
 * The rows themselves, also used inside the mobile drawer — where nothing is
 * ever collapsed, because a drawer that opens to a strip of unlabelled icons
 * helps nobody.
 */
export function SidebarNav({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <nav className="flex flex-col gap-4" aria-label="Sections">
      {NAV_GROUPS.map((g) => (
        <div key={g.label ?? "root"} className="flex flex-col gap-0.5">
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
            <NavLink key={n.href} {...n} collapsed={collapsed} />
          ))}
        </div>
      ))}
    </nav>
  );
}
