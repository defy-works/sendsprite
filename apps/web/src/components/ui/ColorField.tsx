"use client";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { Label } from "./Label";
import { IconX } from "./icons";

/** Enough of a palette to build something coherent without a colour picker. */
const SWATCHES = [
  "#111111",
  "#4b5563",
  "#9ca3af",
  "#ffffff",
  "#4f46e5",
  "#0ea5e9",
  "#059669",
  "#d97706",
  "#dc2626",
  "#db2777",
  "#f3f4f6",
  "#fef3c7",
] as const;

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * A colour, as the contract stores one: `#rrggbb` or nothing.
 *
 * A native `<input type="color">` was the obvious choice and is the wrong one
 * here. It has no "unset" — it always holds a colour, so there is no way to
 * express "inherit the default", which is what most blocks want; its picker is
 * an OS window that ignores every token in this design; and it cannot show the
 * handful of colours that actually belong together in an email. Swatches plus
 * a hex field cover both, and the hex field is what makes a brand colour
 * possible at all.
 */
export function ColorField({
  label,
  value,
  onChange,
  /** Rendered in the swatch when nothing is set, so "default" is visible. */
  fallback = "#000000",
  disabled,
  className,
}: {
  label: string;
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  fallback?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const valid = value === undefined || HEX.test(value);

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {value !== undefined && !disabled && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="flex cursor-pointer items-center gap-1 text-[10px] tracking-[0.08em] text-white/45 uppercase hover:text-white"
          >
            <IconX className="text-[10px]" />
            Default
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-8 w-8 shrink-0 rounded-md border border-white/20"
          style={{ background: valid ? (value ?? fallback) : fallback }}
        />
        <input
          id={id}
          value={value ?? ""}
          disabled={disabled}
          placeholder="default"
          spellCheck={false}
          maxLength={7}
          aria-invalid={!valid}
          onChange={(e) => {
            const raw = e.target.value.trim();
            onChange(raw === "" ? undefined : raw);
          }}
          className={cn(
            "w-full min-w-0 rounded-md border bg-white/4 px-2.5 py-1.5 font-mono text-xs text-white",
            "placeholder:text-white/35 focus:outline-none",
            valid
              ? "border-white/12 focus:border-indigo-500"
              : "border-danger/60",
          )}
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {SWATCHES.map((c) => (
          <Button
            key={c}
            type="button"
            variant="ghost"
            size="iconSm"
            disabled={disabled}
            title={c}
            aria-label={`Use ${c}`}
            aria-pressed={value?.toLowerCase() === c}
            onClick={() => onChange(c)}
            className={cn(
              "h-6 w-6 rounded border p-0",
              value?.toLowerCase() === c
                ? "border-indigo-400 ring-1 ring-indigo-400"
                : "border-white/15 hover:border-white/40",
            )}
            style={{ background: c }}
          >
            <span className="sr-only">{c}</span>
          </Button>
        ))}
      </div>
      {!valid && (
        <p role="alert" className="text-xs text-red-300">
          Use six hex digits, like <code>#4f46e5</code>.
        </p>
      )}
    </div>
  );
}
