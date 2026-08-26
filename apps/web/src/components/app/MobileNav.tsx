"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { IconMenu, IconX } from "@/components/ui/icons";

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
      <Button
        variant="ghost"
        size="iconSm"
        aria-label={open ? "Close menu" : "Menu"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <IconX /> : <IconMenu />}
      </Button>
      {open && (
        <>
          {/* A scrim, so the drawer reads as being in front of the page
              rather than printed on top of it, and so a tap anywhere else
              closes it. */}
          <div
            className="fixed inset-0 top-14 z-30 bg-black/50 motion-safe:animate-[modal-fade_var(--duration-fast)_ease-out]"
            onClick={() => setOpen(false)}
          />
          <div
            className="popover fixed top-14 bottom-0 left-0 z-40 flex w-72 flex-col gap-5 overflow-y-auto rounded-none border-y-0 border-l-0 p-4 motion-safe:animate-[drawer-in_var(--duration-normal)_var(--ease-out-soft)]"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest("a")) setOpen(false);
            }}
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}
