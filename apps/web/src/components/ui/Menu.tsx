"use client";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import NextLink from "next/link";
import { cn } from "@/lib/cn";

/**
 * A dropdown menu anchored to its trigger.
 *
 * Absolutely positioned rather than portalled, unlike {@link Modal}: a menu
 * has to move with its trigger when the page scrolls, and a portal would need
 * a scroll listener and a position calculation to achieve what the normal flow
 * gives for free. The trade is that an ancestor with `overflow: hidden` would
 * clip it — none of the surfaces this is used on set one.
 *
 * Follows the ARIA menu pattern: arrows move, Escape closes and returns focus
 * to the trigger, Tab closes, and a click anywhere else closes.
 */
export function Menu({
  trigger,
  children,
  align = "end",
  className,
  label,
}: {
  /** Receives `{ open }` so a chevron can rotate. */
  trigger: (state: { open: boolean }) => ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  className?: string;
  label?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  const items = () =>
    Array.from(
      list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    ).filter((el) => !el.hasAttribute("data-disabled"));

  const move = (delta: number) => {
    const all = items();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next = at === -1 ? 0 : (at + delta + all.length) % all.length;
    all[next]?.focus();
  };

  return (
    <div ref={root} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => items()[0]?.focus());
          }
        }}
        className="cursor-pointer"
      >
        {trigger({ open })}
      </button>
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Tab") {
              setOpen(false);
            }
          }}
          onClick={(e) => {
            // Any activation inside closes, so a menu item never needs to
            // remember to. `onSelect` handlers have already run by here.
            if ((e.target as HTMLElement).closest('[role="menuitem"]'))
              setOpen(false);
          }}
          className={cn(
            "popover absolute z-50 mt-1.5 min-w-52 p-1 shadow-glass",
            "motion-safe:animate-[pop-in_var(--duration-fast)_var(--ease-out-soft)]",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

const ITEM =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-2 text-left text-sm " +
  "text-white/80 no-underline transition-colors duration-[var(--duration-fast)] " +
  "hover:bg-white/8 hover:text-white focus:bg-white/8 focus:text-white focus:outline-none " +
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[disabled]:hover:bg-transparent";

export function MenuItem({
  icon,
  children,
  onSelect,
  disabled,
  tone = "default",
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
  className?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      data-disabled={disabled ? "" : undefined}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        ITEM,
        tone === "danger" &&
          "text-red-300 hover:bg-red-500/12 hover:text-red-200 focus:bg-red-500/12",
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

export function MenuLink({
  icon,
  children,
  href,
  external,
  className,
}: {
  icon?: ReactNode;
  children: ReactNode;
  href: string;
  external?: boolean;
  className?: string;
}) {
  return (
    <NextLink
      role="menuitem"
      tabIndex={-1}
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cn(ITEM, className)}
    >
      {icon}
      {children}
    </NextLink>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <p className="num-stamp px-2.5 pt-2 pb-1">{children}</p>;
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-white/10" />;
}
