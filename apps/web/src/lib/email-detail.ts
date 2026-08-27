import { unwrapTracking } from "./tracking";
import type { EmailRow } from "@/services/emails";

/**
 * Body as the dashboard shows it: nothing once retention purged it, and
 * the html with our pixel/click rewrites undone so opening the preview does
 * not record an open or route clicks through the tracker.
 */
export function prepareDetail(
  e: Pick<EmailRow, "html" | "text" | "bodyPurgedAt">,
  base: string,
): { html: string | null; text: string | null; purged: boolean } {
  const purged = Boolean(e.bodyPurgedAt);
  return {
    html: purged || !e.html ? null : unwrapTracking(e.html, base),
    text: purged ? null : e.text,
    purged,
  };
}
