import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const INPUT_BASE_CLASS =
  "w-full bg-white/4 border border-white/12 rounded-md px-3 py-2 " +
  "text-sm text-white placeholder:text-white/40 " +
  "focus:outline-none focus:border-indigo-500 focus:bg-indigo-500/6 " +
  "disabled:opacity-50 disabled:cursor-not-allowed " +
  "transition-colors duration-[var(--duration-fast)]";

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = "text", ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(INPUT_BASE_CLASS, className)}
      {...rest}
    />
  );
});
