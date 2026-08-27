"use client";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { IconCheck } from "./icons";

/**
 * A switch, for a setting that takes effect on its own.
 *
 * Built on a real `<input type="checkbox">` with the box visually hidden
 * rather than a `div role="switch"`: the native control already carries the
 * label association, the form value, the keyboard behaviour and the
 * autofill/reset semantics, and re-implementing those in a div is how a
 * checkbox stops working under a password manager or a form reset. Only the
 * paint is ours.
 */
export function Switch({
  checked,
  onChange,
  name,
  disabled,
  label,
  hint,
  id,
}: {
  checked: boolean;
  onChange?: (next: boolean) => void;
  name?: string;
  disabled?: boolean;
  label: ReactNode;
  hint?: ReactNode;
  id?: string;
}) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className="flex items-start gap-3">
      <span className="relative inline-flex shrink-0 pt-0.5">
        <input
          id={inputId}
          type="checkbox"
          role="switch"
          name={name}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange?.(e.target.checked)}
          className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <span
          aria-hidden
          className={cn(
            "block h-5 w-9 rounded-full border transition-colors duration-[var(--duration-normal)]",
            "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-indigo-500",
            "peer-disabled:opacity-45",
            checked
              ? "border-indigo-400 bg-indigo-500"
              : "border-white/20 bg-white/8",
          )}
        >
          <span
            className={cn(
              "mt-[3px] block h-3.5 w-3.5 rounded-full bg-white shadow-sm",
              "transition-transform duration-[var(--duration-normal)] ease-[var(--ease-out-soft)]",
              checked ? "translate-x-[18px]" : "translate-x-[3px]",
            )}
          />
        </span>
      </span>
      <label
        htmlFor={inputId}
        className={cn(
          "flex cursor-pointer flex-col gap-0.5 text-sm text-white/85",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        {label}
        {hint && <span className="text-xs text-white/50">{hint}</span>}
      </label>
    </div>
  );
}

/**
 * Same construction as {@link Switch}, drawn as a box.
 *
 * Works controlled or not: several forms post a set of checkboxes straight to
 * a server action and never read them in React, and making those hold state
 * purely so a box can be painted would be ceremony for nothing. `checked`
 * drives it when given; otherwise `defaultChecked` seeds it and it manages
 * itself.
 */
export function Checkbox({
  checked: controlled,
  defaultChecked = false,
  onChange,
  name,
  value,
  disabled,
  label,
  hint,
  id,
}: {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (next: boolean) => void;
  name?: string;
  value?: string;
  disabled?: boolean;
  label: ReactNode;
  hint?: ReactNode;
  id?: string;
}) {
  const auto = useId();
  const inputId = id ?? auto;
  const [uncontrolled, setUncontrolled] = useState(defaultChecked);
  const checked = controlled ?? uncontrolled;
  return (
    <div className="flex items-start gap-3">
      <span className="relative inline-flex shrink-0 pt-0.5">
        <input
          id={inputId}
          type="checkbox"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={(e) => {
            if (controlled === undefined) setUncontrolled(e.target.checked);
            onChange?.(e.target.checked);
          }}
          className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
        <span
          aria-hidden
          className={cn(
            "flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border transition-colors duration-[var(--duration-fast)]",
            "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-indigo-500",
            "peer-disabled:opacity-45",
            checked
              ? "border-indigo-400 bg-indigo-500 text-white"
              : "border-white/20 bg-white/6 text-transparent",
          )}
        >
          <IconCheck className="text-[11px]" strokeWidth={2.6} />
        </span>
      </span>
      <label
        htmlFor={inputId}
        className={cn(
          "flex cursor-pointer flex-col gap-0.5 text-sm text-white/85",
          disabled && "cursor-not-allowed opacity-60",
        )}
      >
        {label}
        {hint && <span className="text-xs text-white/50">{hint}</span>}
      </label>
    </div>
  );
}
