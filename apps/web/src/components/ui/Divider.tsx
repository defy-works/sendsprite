import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface DividerProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional centered label rendered over the line. */
  label?: ReactNode;
}

export function Divider({ label, className, ...rest }: DividerProps) {
  if (!label) {
    return (
      <hr
        className={cn("border-0 border-t border-white/15 my-2", className)}
        {...rest}
      />
    );
  }
  return (
    <div
      className={cn("relative flex items-center my-2", className)}
      role="separator"
      aria-orientation="horizontal"
      {...rest}
    >
      <span className="flex-1 border-t border-white/15" />
      <span className="px-3 text-[11px] tracking-[0.28em] uppercase text-white/50">
        {label}
      </span>
      <span className="flex-1 border-t border-white/15" />
    </div>
  );
}
