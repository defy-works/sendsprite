import { forwardRef, type LabelHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type LabelProps = LabelHTMLAttributes<HTMLLabelElement>;

/** Small uppercase studio-style label. */
export const Label = forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { className, ...rest },
  ref,
) {
  return (
    <label
      ref={ref}
      className={cn(
        "text-[11px] tracking-[0.28em] uppercase text-indigo-300 font-medium",
        className,
      )}
      {...rest}
    />
  );
});
