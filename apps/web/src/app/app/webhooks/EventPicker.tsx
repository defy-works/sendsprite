"use client";
import { useState } from "react";
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from "@sendsprite/shared";
import { Checkbox } from "@/components/ui/Toggle";
import { IconChevronDown } from "@/components/ui/icons";
import { cn } from "@/lib/cn";

/**
 * The presets, in the order somebody is likely to want them.
 *
 * Sixteen checkboxes is a quiz, and the answer is nearly always one of four
 * shapes: keep a mail log in sync, measure engagement, watch deliverability,
 * or take everything and filter at the other end. Each preset is a set, not a
 * mode — ticking one sets the boxes and you carry on editing them by hand.
 */
const PRESETS: {
  id: string;
  label: string;
  hint: string;
  events: readonly WebhookEventType[];
}[] = [
  {
    id: "lifecycle",
    label: "Delivery",
    hint: "Mirror what happened to each message",
    events: [
      "email.sent",
      "email.delivered",
      "email.delayed",
      "email.bounced",
      "email.failed",
    ],
  },
  {
    id: "engagement",
    label: "Engagement",
    hint: "Opens and clicks",
    events: ["email.opened", "email.clicked"],
  },
  {
    id: "reputation",
    label: "Deliverability",
    hint: "The events that cost you a sender reputation",
    events: ["email.bounced", "email.complained", "contact.unsubscribed"],
  },
  {
    id: "contacts",
    label: "Contacts",
    hint: "Keep a list in step with ours",
    events: [
      "contact.created",
      "contact.updated",
      "contact.unsubscribed",
      "contact.resubscribed",
    ],
  },
  {
    id: "all",
    label: "Everything",
    hint: "All 16, and filter at your end",
    events: WEBHOOK_EVENT_TYPES,
  },
];

const same = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * Which events an endpoint subscribes to.
 *
 * The checkboxes stay in the DOM when the fold is shut — `hidden` on the
 * container, not a conditional render — because they are the form's actual
 * fields. Unmounting them would submit an endpoint subscribed to nothing.
 */
export function EventPicker({
  name = "events",
  initial = [],
}: {
  name?: string;
  initial?: readonly WebhookEventType[];
}) {
  const [chosen, setChosen] = useState<readonly WebhookEventType[]>(initial);
  const [open, setOpen] = useState(false);

  const toggle = (t: WebhookEventType, on: boolean) =>
    setChosen((prev) => (on ? [...prev, t] : prev.filter((x) => x !== t)));

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-sm font-medium">Events</legend>

      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => {
          const active = same(p.events, chosen);
          return (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              aria-pressed={active}
              onClick={() => setChosen(active ? [] : p.events)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs transition-colors",
                active
                  ? "border-indigo-400/60 bg-indigo-500/15 text-indigo-100"
                  : "border-white/12 text-white/65 hover:border-white/30 hover:text-white",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-fit items-center gap-1.5 text-sm text-white/55 transition-colors hover:text-white"
        >
          <IconChevronDown
            className={cn(
              "text-xs transition-transform duration-[var(--duration-fast)]",
              !open && "-rotate-90",
            )}
          />
          {chosen.length === 0
            ? "Choose events"
            : `${chosen.length} of ${WEBHOOK_EVENT_TYPES.length} selected`}
        </button>

        {/* `hidden` as a class, not the attribute: `display:grid` from the
            grid utility wins over the attribute's UA `display:none`, and the
            fold would not fold. The inputs stay mounted either way — they are
            the form's fields. */}
        <div
          className={cn(
            "gap-2 sm:grid-cols-2 lg:grid-cols-3",
            open ? "grid" : "hidden",
          )}
        >
          {WEBHOOK_EVENT_TYPES.map((t) => (
            <Checkbox
              key={t}
              name={name}
              value={t}
              checked={chosen.includes(t)}
              onChange={(on) => toggle(t, on)}
              label={<code className="text-xs">{t}</code>}
            />
          ))}
        </div>
      </div>
    </fieldset>
  );
}
