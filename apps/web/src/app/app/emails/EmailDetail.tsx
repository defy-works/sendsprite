"use client";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody } from "@/components/ui/Card";
import { EmailPreview } from "@/components/ui/EmailPreview";

/** Everything is pre-formatted on the server; this component only switches tabs. */
export interface EventView {
  id: string;
  label: string;
  when: string;
  details: string[];
}
export interface EmailDetailProps {
  /** Null when the body was purged by retention (or never had html). */
  html: string | null;
  text: string | null;
  purged: boolean;
  headers: Record<string, string>;
  events: EventView[];
}

const TABS = ["Preview", "Text", "Headers", "Events"] as const;
type Tab = (typeof TABS)[number];

export function EmailDetail({
  html,
  text,
  purged,
  headers,
  events,
}: EmailDetailProps) {
  const [tab, setTab] = useState<Tab>(purged ? "Events" : "Preview");
  return (
    <Card className="p-0">
      <div className="flex flex-wrap gap-1 border-b border-white/10 px-3 pt-3">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-t-md px-3 py-2 text-sm transition-colors",
              tab === t
                ? "bg-white/8 text-white"
                : "text-white/60 hover:bg-white/5 hover:text-white",
            )}
          >
            {t}
            {t === "Events" && (
              <span className="ml-1 text-xs text-white/50">
                {events.length}
              </span>
            )}
          </button>
        ))}
      </div>
      <CardBody className="p-5">
        {(tab === "Preview" || tab === "Text") && purged ? (
          <p className="text-sm text-white/60">Body purged by retention.</p>
        ) : tab === "Preview" ? (
          html ? (
            // No scripts, no same-origin: the message cannot touch the app.
            // `wrap` is off — a sent message is a whole document, not a body
            // fragment, and wrapping one in another `<html>` is what makes a
            // preview disagree with what the recipient saw.
            <div className="flex flex-col gap-2">
              <EmailPreview title="Email preview" html={html} />
              <p className="text-xs text-white/50">
                Tracking is stripped from this preview; links are live.
              </p>
            </div>
          ) : (
            <p className="text-sm text-white/60">No HTML body.</p>
          )
        ) : tab === "Text" ? (
          text ? (
            <pre className="whitespace-pre-wrap break-words text-sm text-white/80">
              {text}
            </pre>
          ) : (
            <p className="text-sm text-white/60">No text body.</p>
          )
        ) : tab === "Headers" ? (
          Object.keys(headers).length ? (
            <table className="w-full text-sm">
              <tbody>
                {Object.entries(headers).map(([k, v]) => (
                  <tr
                    key={k}
                    className="border-t border-white/8 first:border-0"
                  >
                    <td className="py-2 pr-4 align-top font-mono text-xs text-white/60">
                      {k}
                    </td>
                    <td className="break-all py-2 text-white/80">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-white/60">No custom headers.</p>
          )
        ) : (
          <ol className="flex flex-col gap-3">
            {events.map((ev) => (
              <li key={ev.id} className="flex gap-3">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-indigo-400" />
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="muted">{ev.label}</Badge>
                    <span className="text-xs text-white/50">{ev.when}</span>
                  </div>
                  {ev.details.map((d, i) => (
                    <p key={i} className="break-all text-xs text-white/70">
                      {d}
                    </p>
                  ))}
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  );
}
