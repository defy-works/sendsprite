import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

export type ButtonVariant =
  "primary" | "secondary" | "subtle" | "ghost" | "danger" | "dangerSubtle";
export type ButtonSize = "sm" | "md" | "lg" | "icon" | "iconSm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render the given child as the button, forwarding all props + ref. */
  asChild?: boolean;
  /**
   * Swaps the leading icon for a spinner and disables the button. Prefer this
   * over rewriting the label to "Saving…": a label that changes width makes
   * the row reflow under the pointer, and the button then no longer says what
   * it does while it is doing it.
   */
  loading?: boolean;
  /** Leading icon. Hidden while `loading`, which takes its place. */
  icon?: ReactNode;
}

const BASE =
  "relative inline-flex items-center justify-center gap-2 rounded-md font-medium tracking-wide " +
  "cursor-pointer select-none whitespace-nowrap " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-indigo-500 " +
  "transition-[background-color,border-color,color,box-shadow,transform] " +
  "duration-[var(--duration-fast)] ease-[var(--ease-out-soft)] " +
  "active:translate-y-px " +
  "disabled:opacity-45 disabled:pointer-events-none disabled:active:translate-y-0";

/**
 * Every variant carries either a fill or a border.
 *
 * `ghost` used to be the default for secondary actions on a card — text at
 * 75% white with nothing behind it. On `.glass` that reads as disabled help
 * text, not as a button, so a "Remove" or "Disconnect" sitting in a card was
 * invisible until you happened to mouse over it. `ghost` is now reserved for
 * toolbars and nav rows, where a row of borders would be worse; anything the
 * user is meant to find on a surface uses `subtle`, which has both.
 */
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-indigo-500 text-white shadow-[0_1px_0_rgba(255,255,255,0.14)_inset] " +
    "hover:bg-indigo-400 hover:shadow-[0_0_18px_rgba(99,102,241,0.35)] active:bg-indigo-600",
  secondary:
    "border border-indigo-400/70 text-indigo-200 hover:border-indigo-300 hover:bg-indigo-500/15 hover:text-white",
  subtle:
    "border border-white/14 bg-white/6 text-white/85 " +
    "hover:border-white/25 hover:bg-white/12 hover:text-white",
  ghost: "text-white/70 hover:bg-white/8 hover:text-white",
  danger:
    "bg-danger text-white hover:bg-red-400 hover:shadow-[0_0_18px_rgba(239,68,68,0.3)]",
  dangerSubtle:
    "border border-red-400/40 bg-red-500/8 text-red-200 " +
    "hover:border-red-400/70 hover:bg-red-500/18 hover:text-red-100",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
  icon: "h-10 w-10 text-base",
  iconSm: "h-8 w-8 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      asChild = false,
      loading = false,
      icon,
      className,
      type,
      disabled,
      children,
      ...rest
    },
    ref,
  ) {
    const Comp = asChild ? Slot : "button";
    // `asChild` forwards a single element, so the spinner/icon wrappers cannot
    // be added around the caller's child — it would stop being one element.
    const content = asChild ? (
      children
    ) : (
      <>
        {loading ? <Spinner size={14} /> : icon}
        {children}
      </>
    );
    return (
      <Comp
        ref={ref}
        // Only set `type` when not delegating to a child element - Slot
        // may target a non-button node where `type` does not apply.
        {...(!asChild
          ? {
              type: type ?? "button",
              disabled: disabled || loading,
              "aria-busy": loading || undefined,
            }
          : {})}
        className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
        {...rest}
      >
        {content}
      </Comp>
    );
  },
);
