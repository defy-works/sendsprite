"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const KEY = "sendsprite:sidebar-collapsed";

interface Shell {
  collapsed: boolean;
  toggle: () => void;
  /** False until the stored preference has been read, so nothing animates on load. */
  ready: boolean;
}

const Ctx = createContext<Shell>({
  collapsed: false,
  toggle: () => {},
  ready: false,
});

/**
 * Whether the rail is collapsed, shared by the two things that have to agree
 * about it.
 *
 * The sidebar owns the toggle, but the top bar owns the block above the
 * sidebar — and the vertical rule between that block and the rest of the bar
 * only lines up with the sidebar's edge if both are the same width. So the
 * state cannot live in the sidebar: collapsing would move one line and not the
 * other, which is exactly the kind of half-millimetre wrongness that makes an
 * interface feel unfinished.
 *
 * The preference is per browser, in `localStorage`. It is a viewing
 * preference, not account state: syncing it would mean a write on every toggle
 * and a layout that changes under you on another machine.
 */
export function ShellState({ children }: { children: ReactNode }) {
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

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(KEY, next ? "1" : "0");
      } catch {
        // Same: the preference is lost, the sidebar is not.
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ collapsed, toggle, ready }),
    [collapsed, toggle, ready],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useShell = () => useContext(Ctx);

/**
 * The one place the rail's two widths are written down.
 *
 * Used by the sidebar and by the top bar's logo block, which is why it is a
 * constant and not a class on each. Both forms are spelled out in full rather
 * than composed — Tailwind scans source text for candidates, so a class built
 * as `md:${width}` is a class that never gets generated.
 */
export const railWidth = (collapsed: boolean) =>
  collapsed ? "w-[60px]" : "w-60";

export const railWidthMd = (collapsed: boolean) =>
  collapsed ? "md:w-[60px]" : "md:w-60";
