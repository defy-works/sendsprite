import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { INPUT_BASE_CLASS } from "./Input";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/**
 * Native `<select>` styled to match Input; chevron drawn as a CSS
 * background-image so we avoid a JS icon dependency and the native
 * control still opens the platform picker.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={cn(
          INPUT_BASE_CLASS,
          "appearance-none pr-9 cursor-pointer",
          // Inline SVG chevron, indigo-300 @ 70% alpha.
          "bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M3%204.5L6%207.5L9%204.5%22%20stroke%3D%22%23a5b4fc%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22/%3E%3C/svg%3E')]",
          "bg-no-repeat bg-[right_0.75rem_center] bg-[length:12px_12px]",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
    );
  },
);
