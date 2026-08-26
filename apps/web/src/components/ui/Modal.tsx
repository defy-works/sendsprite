"use client";
import { useCallback, useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { IconX } from "./icons";

/**
 * The dashboard's one modal.
 *
 * Rendered into a portal on `document.body` rather than in place, because a
 * dialog opened from inside a `.glass` card inherits that card's
 * `backdrop-filter`, and a filtered ancestor makes `position: fixed`
 * containing-block-relative — the overlay then covers the card instead of the
 * viewport. The bug is invisible until a dialog is opened from a scrolled
 * card, which is most of them.
 *
 * Escape dismisses. The backdrop dismisses only when `dismissOnBackdrop` says
 * so: a stray click outside should not silently discard a decision the size of
 * "send to 40 000 people", but it should close a preview.
 */
export function Modal({
  open,
  onDismiss,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissOnBackdrop = false,
}: {
  open: boolean;
  onDismiss: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  dismissOnBackdrop?: boolean;
}) {
  const titleId = useId();
  const descId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const dismiss = useCallback(() => onDismiss(), [onDismiss]);

  useEffect(() => {
    if (!open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    // The page behind must not scroll under the overlay; the scrollbar is
    // replaced with padding so the layout does not jump by its width.
    const { body } = document;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    const prevOverflow = body.style.overflow;
    const prevPad = body.style.paddingRight;
    body.style.overflow = "hidden";
    if (gap > 0) body.style.paddingRight = `${gap}px`;
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPad;
      restoreFocus.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismiss();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      // Focus trap. Without it Tab walks into the page behind the overlay,
      // where every control is visually covered but still reachable.
      const focusable = panel.current.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, dismiss]);

  // Move focus into the panel once it exists, preferring the first control
  // over the panel itself so a keyboard user is already on something useful.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      const el = panel.current?.querySelector<HTMLElement>(
        "[data-autofocus],input:not([disabled]),textarea:not([disabled]),button:not([disabled])",
      );
      (el ?? panel.current)?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-100 flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-[2px] motion-safe:animate-[modal-fade_var(--duration-fast)_ease-out]"
      onMouseDown={(e) => {
        if (dismissOnBackdrop && e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "popover flex max-h-full w-full flex-col gap-4 overflow-y-auto p-6 shadow-glass outline-none",
          "motion-safe:animate-[modal-rise_var(--duration-normal)_var(--ease-out-soft)]",
          size === "sm" && "max-w-sm",
          size === "md" && "max-w-lg",
          size === "lg" && "max-w-2xl",
          size === "xl" && "max-w-4xl",
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-base font-medium">
              {title}
            </h2>
            {description && (
              <p id={descId} className="text-sm text-white/65">
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Close"
            onClick={dismiss}
            className="-mt-1 -mr-1"
          >
            <IconX />
          </Button>
        </div>
        {children}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-3 pt-1">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
