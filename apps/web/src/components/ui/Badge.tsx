import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type BadgeVariant =
  "indigo" | "muted" | "success" | "warning" | "danger";
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const BASE =
  "inline-flex items-center px-2 py-[3px] rounded-full text-[10px] font-semibold tracking-[0.08em] uppercase";
const VARIANTS: Record<BadgeVariant, string> = {
  indigo: "bg-indigo-500/18 text-indigo-300",
  muted: "bg-white/8 text-white/65",
  success: "bg-success/18 text-green-300",
  warning: "bg-warning/18 text-amber-300",
  danger: "bg-danger/18 text-red-300",
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = "indigo", className, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(BASE, VARIANTS[variant], className)}
      {...rest}
    />
  );
});
