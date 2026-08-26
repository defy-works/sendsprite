"use client";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Label } from "./Label";

export interface Segment<T extends string> {
  value: T;
  /** Icon or short word. Keep it short — the control is one row. */
  label: ReactNode;
  title?: string;
}

/**
 * A radio group drawn as one strip.
 *
 * For the two-to-four-way choices the block inspector is full of — alignment,
 * corner style, image width. A `<Select>` for three icons would hide all three
 * behind a click, and three checkboxes would not say they are exclusive.
 *
 * `role="radiogroup"` with real `aria-checked` buttons rather than hidden
 * inputs: the value is never posted (the inspector writes it into the block
 * tree directly), so an input would exist only to be visually replaced.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  label?: string;
  value: T;
  options: readonly Segment<T>[];
  onChange: (next: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <Label>{label}</Label>}
      <div
        role="radiogroup"
        aria-label={label}
        className="flex gap-0.5 rounded-md border border-white/12 bg-white/4 p-0.5"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            title={o.title}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-xs",
              "transition-colors duration-[var(--duration-fast)]",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500",
              "disabled:cursor-not-allowed disabled:opacity-45",
              value === o.value
                ? "bg-indigo-500/25 text-white"
                : "text-white/55 hover:bg-white/6 hover:text-white",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
