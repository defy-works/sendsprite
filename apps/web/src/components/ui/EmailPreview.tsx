"use client";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./Button";
import { IconEye, IconExternal } from "./icons";

export type PreviewWidth = "desktop" | "mobile";

const WIDTH: Record<PreviewWidth, number> = { desktop: 680, mobile: 390 };

/**
 * The sandboxed frame every email preview in the dashboard renders into.
 *
 * `sandbox=""` — no scripts, no forms, no same-origin, no top navigation.
 * Campaign bodies are checked by the block contract and template bodies are
 * escaped on substitution, so this is defence in depth; but the frame renders
 * customer-authored markup inside a dashboard session, and one bug in a URL
 * check must not become account takeover.
 *
 * Two things it does that a bare `<iframe srcDoc>` did not:
 *
 * 1. **A light canvas.** `color-scheme: dark` on the dashboard inherits into a
 *    `srcdoc` iframe, so a document that does not paint its own root gets a
 *    near-black canvas — which is why the preview showed a light email sitting
 *    on a dark slab below the fold. Campaign HTML now paints its own root;
 *    template bodies are arbitrary fragments that never will, so `wrap` puts
 *    a light document around them.
 * 2. **A phone width.** Most mail is opened on a phone and the 600px table is
 *    exactly where a layout stops working. A toggle costs one piece of state.
 */
export function EmailPreview({
  html,
  title,
  /** Wrap the value in a minimal light document. For raw body fragments. */
  wrap = false,
  className,
  height = "36rem",
}: {
  html: string;
  title: string;
  wrap?: boolean;
  className?: string;
  height?: string;
}) {
  const [width, setWidth] = useState<PreviewWidth>("desktop");
  const doc = wrap ? wrapFragment(html) : html;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-3">
        <div
          className="flex gap-0.5 rounded-md border border-white/10 bg-white/4 p-0.5"
          role="group"
          aria-label="Preview width"
        >
          {(["desktop", "mobile"] as const).map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={width === w}
              onClick={() => setWidth(w)}
              className={cn(
                "cursor-pointer rounded-sm px-2.5 py-1 text-xs capitalize transition-colors",
                width === w
                  ? "bg-white/12 text-white"
                  : "text-white/55 hover:text-white",
              )}
            >
              {w}
            </button>
          ))}
        </div>
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="text-white/50 hover:text-white"
        >
          {/* A blob URL rather than a data: URL: Chrome blocks top-level
              navigation to data: documents, so the "open in a tab" link a
              data: URL produces is silently dead. */}
          <button type="button" onClick={() => openInTab(doc)}>
            <IconExternal className="text-xs" />
            Open in a tab
          </button>
        </Button>
      </div>
      <div className="flex justify-center rounded-lg border border-white/10 bg-white/4 p-2">
        <iframe
          title={title}
          sandbox=""
          srcDoc={doc}
          style={{ height, maxWidth: "100%", width: WIDTH[width] }}
          className="rounded-md border border-white/10 bg-white transition-[width] duration-[var(--duration-normal)] ease-[var(--ease-out-soft)]"
        />
      </div>
      <p className="flex items-center gap-1.5 text-xs text-white/45">
        <IconEye className="text-[13px]" />
        Rendered by the same code the send uses, in a frame that runs nothing.
      </p>
    </div>
  );
}

function openInTab(doc: string) {
  const url = URL.createObjectURL(
    new Blob([doc], { type: "text/html;charset=utf-8" }),
  );
  window.open(url, "_blank", "noopener");
  // The tab has read it by the time a frame has passed; holding the object
  // alive for the life of the page would leak one blob per click.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * A light document around a body fragment.
 *
 * Deliberately minimal — no reset, no font stack, no container. This is a
 * preview of what the fragment *is*, and styling it here would make the
 * dashboard show something the recipient will not get.
 */
function wrapFragment(fragment: string): string {
  return (
    `<!doctype html><html style="background:#ffffff;color-scheme:light">` +
    `<head><meta charset="utf-8" />` +
    `<meta name="color-scheme" content="light" />` +
    `<meta name="viewport" content="width=device-width,initial-scale=1" /></head>` +
    `<body style="margin:0;padding:16px;background:#ffffff;color:#111111">` +
    fragment +
    `</body></html>`
  );
}
