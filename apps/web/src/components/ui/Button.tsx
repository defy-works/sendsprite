import { Slot } from "@radix-ui/react-slot";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render the given child as the button, forwarding all props + ref. */
  asChild?: boolean;
}

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium tracking-wide " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-indigo-500 transition-colors duration-[var(--duration-fast)] " +
  "disabled:opacity-50 disabled:pointer-events-none";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-indigo-500 text-white hover:bg-indigo-400 active:bg-indigo-600",
  secondary: "border border-indigo-500 text-indigo-300 hover:bg-indigo-500/15",
  ghost: "text-white/75 hover:text-white hover:bg-white/6",
  danger: "bg-danger text-white hover:opacity-90",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-base",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "primary",
      size = "md",
      asChild = false,
      className,
      type,
      ...rest
    },
    ref,
  ) {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        // Only set `type` when not delegating to a child element - Slot
        // may target a non-button node where `type` does not apply.
        {...(!asChild ? { type: type ?? "button" } : {})}
        className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
        {...rest}
      />
    );
  },
);
