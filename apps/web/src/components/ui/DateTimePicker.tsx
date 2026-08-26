"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { INPUT_BASE_CLASS } from "./Input";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconX,
} from "./icons";

/**
 * A date and a time, in the reader's own zone.
 *
 * The native `<input type="datetime-local">` is the last browser-drawn control
 * this dashboard had, and the reason it survived one sweep is that replacing a
 * date picker badly is worse than keeping an ugly one: the platform control
 * carries keyboard entry, locale ordering, and screen-reader semantics that a
 * `div` of buttons does not get for free. So this is not a `div` of buttons.
 * It is a real `<input>` for the time, a real grid with `role="grid"` for the
 * date, and every keyboard behaviour a calendar is expected to have — arrows
 * by day, PageUp/PageDown by month, Home/End to the ends of the week, Enter to
 * pick, Escape to close.
 *
 * ## Everything here is local time
 *
 * `value` is a `Date`, which is an instant; what the calendar shows is that
 * instant in the browser's zone, and what a click produces is a local
 * wall-clock time converted back to an instant. That matches what
 * `datetime-local` did and what the copy has always said, and it is the only
 * reading a person scheduling a newsletter for "Tuesday at nine" means. The
 * zone is named under the field, because "nine o'clock where?" is the question
 * that turns a scheduling mistake into a 3 a.m. send.
 */

const DAY_MS = 86_400_000;

/** Monday-first: this product's audience schedules working weeks. */
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate());

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** Days in the grid: the whole month, padded to whole Monday-first weeks. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // `getDay()` is Sunday-first; shift so Monday is 0.
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(first.getTime() - lead * DAY_MS);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++)
    days.push(
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + i),
    );
  // Trim a trailing all-next-month week so a short month is five rows, not six.
  return days.slice(
    0,
    days[35] && days[35].getMonth() !== month.getMonth() ? 35 : 42,
  );
}

/** `HH:MM` in local time, which is what an `<input type=time>` speaks. */
const timeValue = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

const MONTH_FMT = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});
const FULL_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const DAY_FMT = new Intl.DateTimeFormat(undefined, { dateStyle: "full" });

/** The browser's zone, named the way a person would say it. */
function zoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "your local time";
  }
}

export function DateTimePicker({
  value,
  onChange,
  min,
  disabled,
  id,
  placeholder = "As soon as possible",
  className,
}: {
  value: Date | null;
  onChange: (next: Date | null) => void;
  /** Nothing before this is selectable. Usually "now". */
  min?: Date;
  disabled?: boolean;
  id?: string;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfDay(value ?? new Date()));
  /** The day the arrow keys are on, which is not yet the chosen day. */
  const [cursor, setCursor] = useState(() => startOfDay(value ?? new Date()));
  const root = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  const minDay = useMemo(() => (min ? startOfDay(min) : null), [min]);
  const days = useMemo(() => monthGrid(month), [month]);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) root.current?.querySelector("button")?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the roving focus on the cursor while the grid is open, so an arrow
  // key moves the *browser's* focus and a screen reader announces the new day.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      grid.current
        ?.querySelector<HTMLElement>('[data-cursor="true"]')
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(id);
  }, [open, cursor, month]);

  const tooEarly = (d: Date) =>
    minDay !== null && d.getTime() < minDay.getTime();

  /** Applies a day, keeping whatever time is already chosen. */
  const pickDay = (day: Date) => {
    if (tooEarly(day)) return;
    const base = value ?? defaultTime(day, min);
    const next = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      base.getHours(),
      base.getMinutes(),
      0,
      0,
    );
    onChange(clampToMin(next, min));
    setCursor(day);
  };

  const pickTime = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    if (
      h === undefined ||
      m === undefined ||
      Number.isNaN(h) ||
      Number.isNaN(m)
    )
      return;
    const day = value ?? cursor;
    onChange(
      new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0),
    );
  };

  const move = (deltaDays: number) => {
    const next = new Date(cursor.getTime() + deltaDays * DAY_MS);
    setCursor(startOfDay(next));
    if (next.getMonth() !== month.getMonth()) setMonth(startOfDay(next));
  };

  const moveMonth = (delta: number) => {
    const next = new Date(month.getFullYear(), month.getMonth() + delta, 1);
    setMonth(next);
    setCursor(next);
  };

  const onGridKey = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    if (e.key in step) {
      e.preventDefault();
      return move(step[e.key]!);
    }
    if (e.key === "PageUp" || e.key === "PageDown") {
      e.preventDefault();
      return moveMonth(e.key === "PageUp" ? -1 : 1);
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      // Monday-first, so the offset to the start of the week is the shifted day.
      const offset = (cursor.getDay() + 6) % 7;
      return move(e.key === "Home" ? -offset : 6 - offset);
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pickDay(cursor);
      return close(true);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  const today = startOfDay(new Date());

  return (
    <div ref={root} className={cn("relative", className)}>
      <div className="flex gap-2">
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            if (value) {
              setMonth(startOfDay(value));
              setCursor(startOfDay(value));
            }
            setOpen((o) => !o);
          }}
          className={cn(
            INPUT_BASE_CLASS,
            "flex cursor-pointer items-center gap-2 text-left",
            open && "border-indigo-500 bg-indigo-500/6",
            !value && "text-white/45",
          )}
        >
          <IconCalendar className="text-indigo-300/80" />
          <span className="truncate">
            {value ? FULL_FMT.format(value) : placeholder}
          </span>
        </button>
        {value && !disabled && (
          <Button
            variant="subtle"
            size="icon"
            aria-label="Clear the scheduled time"
            className="shrink-0"
            onClick={() => onChange(null)}
          >
            <IconX />
          </Button>
        )}
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="Choose a date and time"
          className="glass-strong absolute z-50 mt-1 w-[19rem] p-3 shadow-glass motion-safe:animate-[pop-in_var(--duration-fast)_var(--ease-out-soft)]"
        >
          <div className="mb-2 flex items-center justify-between">
            <Button
              size="iconSm"
              variant="ghost"
              aria-label="Previous month"
              onClick={() => moveMonth(-1)}
            >
              <IconChevronLeft />
            </Button>
            <span aria-live="polite" className="text-sm font-medium">
              {MONTH_FMT.format(month)}
            </span>
            <Button
              size="iconSm"
              variant="ghost"
              aria-label="Next month"
              onClick={() => moveMonth(1)}
            >
              <IconChevronRight />
            </Button>
          </div>

          <div
            ref={grid}
            role="grid"
            aria-label={MONTH_FMT.format(month)}
            onKeyDown={onGridKey}
            className="grid grid-cols-7 gap-0.5"
          >
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                role="columnheader"
                aria-label={d}
                className="pb-1 text-center text-[10px] tracking-wider text-white/35 uppercase"
              >
                {d[0]}
              </div>
            ))}
            {days.map((d) => {
              const outside = d.getMonth() !== month.getMonth();
              const chosen = value !== null && sameDay(d, value);
              const disabledDay = tooEarly(d);
              const isCursor = sameDay(d, cursor);
              return (
                <button
                  key={d.getTime()}
                  type="button"
                  role="gridcell"
                  // One tab stop for the whole grid: tabbing lands on the
                  // cursor, and arrows move within. Forty-two tab stops is
                  // what makes a calendar unusable from a keyboard.
                  tabIndex={isCursor ? 0 : -1}
                  data-cursor={isCursor}
                  aria-selected={chosen}
                  aria-disabled={disabledDay}
                  aria-label={DAY_FMT.format(d)}
                  disabled={disabledDay}
                  onClick={() => {
                    pickDay(d);
                    close(true);
                  }}
                  className={cn(
                    "h-8 rounded-md text-sm transition-colors",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500",
                    disabledDay && "cursor-not-allowed text-white/15",
                    !disabledDay && "cursor-pointer hover:bg-white/8",
                    outside && !chosen && "text-white/30",
                    chosen && "bg-indigo-500 text-white hover:bg-indigo-400",
                    !chosen &&
                      sameDay(d, today) &&
                      "font-semibold text-indigo-300",
                  )}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-white/10 pt-3">
            <label
              htmlFor={`${id ?? "dt"}-time`}
              className="text-[11px] tracking-[0.18em] text-indigo-300 uppercase"
            >
              Time
            </label>
            {/* A native `<input type="time">`, kept on purpose. Unlike the
                date popup it renders as a plain text field with segments,
                which styles cleanly here and gives typed entry, spinners and
                the locale's own 12/24-hour convention for free. */}
            <input
              id={`${id ?? "dt"}-time`}
              type="time"
              value={value ? timeValue(value) : "09:00"}
              onChange={(e) => pickTime(e.target.value)}
              className={cn(INPUT_BASE_CLASS, "w-auto flex-1 py-1.5")}
            />
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {shortcuts(min).map((s) => (
              <Button
                key={s.label}
                size="sm"
                variant="ghost"
                className="text-white/60"
                onClick={() => {
                  onChange(s.at);
                  setMonth(startOfDay(s.at));
                  setCursor(startOfDay(s.at));
                  close(true);
                }}
              >
                {s.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      <p className="mt-1 text-xs text-white/50">
        Times are {zoneName()} — your own zone, not the recipient&apos;s.
      </p>
    </div>
  );
}

/** 9 a.m. on the chosen day, or the earliest allowed time if that has passed. */
function defaultTime(day: Date, min?: Date): Date {
  const nine = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    9,
    0,
    0,
    0,
  );
  return clampToMin(nine, min);
}

/**
 * Nudges a time forward past `min`.
 *
 * Only ever forward: a scheduled send in the past is refused by the service,
 * and picking today when it is already noon should give you a usable time
 * rather than an error you have to read.
 */
function clampToMin(d: Date, min?: Date): Date {
  if (!min || d.getTime() > min.getTime()) return d;
  // The next round five minutes after `min`, which reads as a choice rather
  // than as a timestamp.
  const next = new Date(min.getTime() + 5 * 60_000);
  next.setSeconds(0, 0);
  next.setMinutes(Math.ceil(next.getMinutes() / 5) * 5);
  return next;
}

/** The three times somebody actually picks, so most schedules are one click. */
function shortcuts(min?: Date): { label: string; at: Date }[] {
  const now = new Date();
  const at9 = (offsetDays: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9);
    d.setDate(d.getDate() + offsetDays);
    return clampToMin(d, min);
  };
  const daysToMonday = (8 - now.getDay()) % 7 || 7;
  return [
    {
      label: "In an hour",
      at: clampToMin(new Date(now.getTime() + 3600_000), min),
    },
    { label: "Tomorrow 9am", at: at9(1) },
    { label: "Monday 9am", at: at9(daysToMonday) },
  ];
}
