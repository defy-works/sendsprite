"use client";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { INPUT_BASE_CLASS } from "./Input";
import { IconCheck, IconChevronDown } from "./icons";

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Second line, for the cases where the label alone is not enough. */
  hint?: ReactNode;
  disabled?: boolean;
  /** Groups adjacent options under a heading. */
  group?: string;
}

export interface SelectProps<T extends string = string> {
  id?: string;
  name?: string;
  /** Controlled value. Omit it (with `defaultValue`) for an uncontrolled field. */
  value?: T | "";
  /**
   * Uncontrolled initial value. Several forms post straight to a server action
   * and never read the choice in React; making them hold state just to render
   * a dropdown would be ceremony for nothing.
   */
  defaultValue?: T | "";
  options: readonly SelectOption<T>[];
  onChange?: (value: T) => void;
  /** Shown when the value is `""`. */
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

/**
 * A listbox, not a `<select>`.
 *
 * The native control cannot be styled below the button: its popup is drawn by
 * the OS, so on this dark surface Windows and Linux render a white menu with
 * blue selection in the middle of the product. That is the "browser-native
 * components" problem — the closed state matched and the open state did not,
 * which is worse than either being consistently wrong.
 *
 * Implements the ARIA listbox pattern rather than a `div` with click handlers:
 * roving `aria-activedescendant`, type-ahead, Home/End, Escape, and the
 * arrow-key behaviour a `<select>` has. A hidden `<input>` carries `name` so
 * the component still works inside a plain `<form>` server action, which
 * several call sites rely on.
 */
export function Select<T extends string = string>({
  id,
  name,
  value: controlled,
  defaultValue,
  options,
  onChange,
  placeholder = "Select…",
  disabled,
  required,
  className,
  ...aria
}: SelectProps<T>) {
  const autoId = useId();
  const buttonId = id ?? autoId;
  const listId = `${buttonId}-listbox`;
  const [uncontrolled, setUncontrolled] = useState<T | "">(defaultValue ?? "");
  const value = controlled ?? uncontrolled;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef({ buffer: "", at: 0 });

  const selectedIndex = useMemo(
    () => options.findIndex((o) => o.value === value),
    [options, value],
  );
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const enabledIndexes = useMemo(
    () => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0),
    [options],
  );

  const openList = useCallback(() => {
    if (disabled) return;
    setActive(selectedIndex >= 0 ? selectedIndex : (enabledIndexes[0] ?? 0));
    setOpen(true);
  }, [disabled, selectedIndex, enabledIndexes]);

  const commit = useCallback(
    (index: number) => {
      const o = options[index];
      if (!o || o.disabled) return;
      if (controlled === undefined) setUncontrolled(o.value);
      onChange?.(o.value);
      setOpen(false);
    },
    [options, onChange, controlled],
  );

  // Close on a click that lands outside, and on scroll of an ancestor: the
  // menu is absolutely positioned, so a scroll would otherwise leave it
  // hanging next to nothing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open || !list.current) return;
    list.current
      .querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const step = (delta: number) => {
    const pos = enabledIndexes.indexOf(active);
    const nextPos =
      pos === -1
        ? 0
        : Math.min(Math.max(pos + delta, 0), enabledIndexes.length - 1);
    setActive(enabledIndexes[nextPos] ?? active);
  };

  /** Jump to the next option whose label starts with what was typed. */
  const typeAhead = (key: string) => {
    const now = Date.now();
    const t = typed.current;
    t.buffer = now - t.at > 700 ? key : t.buffer + key;
    t.at = now;
    const q = t.buffer.toLowerCase();
    const text = (o: SelectOption<T>) =>
      (typeof o.label === "string" ? o.label : o.value).toLowerCase();
    const from = enabledIndexes.indexOf(active);
    const order = [
      ...enabledIndexes.slice(from + 1),
      ...enabledIndexes.slice(0, from + 1),
    ];
    const hit = order.find((i) => text(options[i]!).startsWith(q));
    if (hit !== undefined) {
      setActive(hit);
      if (!open) commit(hit);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        if (!open) return openList();
        return step(e.key === "ArrowDown" ? 1 : -1);
      }
      case "Home":
        if (open) {
          e.preventDefault();
          setActive(enabledIndexes[0] ?? 0);
        }
        return;
      case "End":
        if (open) {
          e.preventDefault();
          setActive(enabledIndexes[enabledIndexes.length - 1] ?? 0);
        }
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (!open) return openList();
        return commit(active);
      case "Escape":
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        return;
      case "Tab":
        setOpen(false);
        return;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          typeAhead(e.key);
        }
    }
  };

  let lastGroup: string | undefined;

  return (
    <div ref={root} className={cn("relative", className)}>
      {name && (
        <input type="hidden" name={name} value={value} required={required} />
      )}
      <button
        type="button"
        id={buttonId}
        role="combobox"
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={
          open && options[active] ? `${listId}-${active}` : undefined
        }
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        className={cn(
          INPUT_BASE_CLASS,
          "flex cursor-pointer items-center justify-between gap-2 text-left",
          open && "border-indigo-500 bg-indigo-500/6",
          !selected && "text-white/45",
        )}
        {...aria}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <IconChevronDown
          className={cn(
            "text-indigo-300/80 transition-transform duration-[var(--duration-fast)]",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-labelledby={buttonId}
          tabIndex={-1}
          className={cn(
            "popover absolute z-50 mt-1 max-h-72 w-full overflow-y-auto p-1 shadow-glass",
            "motion-safe:animate-[pop-in_var(--duration-fast)_var(--ease-out-soft)]",
          )}
        >
          {options.length === 0 && (
            <li className="px-3 py-2 text-sm text-white/45">
              Nothing to choose from
            </li>
          )}
          {options.map((o, i) => {
            const header = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return (
              <li key={o.value} role="presentation">
                {header && (
                  <p className="num-stamp px-3 pt-2.5 pb-1">{header}</p>
                )}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  aria-disabled={o.disabled || undefined}
                  data-active={i === active}
                  // The label, when it is plain text, as an attribute. The
                  // accessible name of an option includes its hint — which is
                  // right for a screen reader and useless for a test that
                  // wants to click "Full" rather than "Full Every endpoint
                  // this team can reach".
                  data-label={typeof o.label === "string" ? o.label : undefined}
                  onMouseEnter={() => !o.disabled && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(i)}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-sm px-2.5 py-2 text-sm",
                    o.disabled && "cursor-not-allowed opacity-45",
                    i === active && !o.disabled && "bg-indigo-500/22",
                  )}
                >
                  <IconCheck
                    className={cn(
                      "mt-0.5 text-indigo-300",
                      o.value === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{o.label}</span>
                    {o.hint && (
                      <span className="text-xs text-white/50">{o.hint}</span>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
