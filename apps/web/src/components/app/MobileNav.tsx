"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

/** Header menu below `md`. Closes on navigation, Escape, or link click. */
export function MobileNav({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer rounded-md px-2 py-1 text-sm text-white/75 hover:bg-white/6 hover:text-white"
      >
        ☰
      </button>
      {open && (
        <div
          className="absolute top-14 left-0 z-20 flex w-64 flex-col gap-4 border-r border-b border-white/10 bg-shadow p-4"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
