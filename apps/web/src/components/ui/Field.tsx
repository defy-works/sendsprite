import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Label } from "./Label";

/**
 * Label, control, hint and error as one unit.
 *
 * Every form in the dashboard had been hand-assembling this, which is why the
 * hint sat 4px below the input in one place and 6px in another, and why some
 * errors were announced to a screen reader and some were not. The control is
 * a child rather than a prop so this stays a layout component and never has to
 * know which input it is wrapping.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  /** Must match the control's `id`; that is what makes the label clickable. */
  id?: string;
  label?: ReactNode;
  hint?: ReactNode;
  /** Replaces the hint while set, and is announced. */
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <Label htmlFor={id}>
          {label}
          {required && (
            <span aria-hidden className="ml-1 text-indigo-400">
              *
            </span>
          )}
        </Label>
      )}
      {children}
      {error ? (
        <p
          id={id ? `${id}-error` : undefined}
          role="alert"
          className="text-xs text-red-300"
        >
          {error}
        </p>
      ) : (
        hint && (
          <p
            id={id ? `${id}-hint` : undefined}
            className="text-xs text-white/50"
          >
            {hint}
          </p>
        )
      )}
    </div>
  );
}
