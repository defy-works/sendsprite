import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export interface SpinnerProps extends HTMLAttributes<HTMLDivElement> {
  /** Edge length in px. */
  size?: number;
}

/**
 * Minimal rotating indigo ring for loading states. Uses inline
 * keyframes rather than a Tailwind animation so the component is
 * self-contained and works outside of app CSS.
 */
export function Spinner({
  size = 18,
  className,
  style,
  ...rest
}: SpinnerProps) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn("inline-block align-middle", className)}
      style={{ width: size, height: size, ...style }}
      {...rest}
    >
      <span
        aria-hidden
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          borderRadius: "50%",
          border: "1.5px solid rgba(165, 180, 252, 0.25)",
          borderTopColor: "var(--color-indigo-400)",
          animation: "spinner-rotate 0.8s linear infinite",
        }}
      />
      <style>{`@keyframes spinner-rotate { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
