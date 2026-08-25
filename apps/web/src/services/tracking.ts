import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { emails } from "@/db/schema";
import { requestMeta } from "@/lib/audit";
import { enqueue } from "@/jobs/enqueue";
import { recordEvent } from "./email-events";
import { publicEmail } from "./ingest";
import { fanOutEvent } from "./webhooks";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** UTC calendar day, the window in which one (ua[, url]) counts once. */
const today = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * Open/click tracking hit → timeline event + webhook fan-out, honouring the
 * email's own `trackOpens`/`trackClicks` flag. Unknown ids and emails with
 * tracking off record nothing. Never throws: a tracking failure must not
 * break the pixel or the redirect, so errors are logged and swallowed.
 */
export async function recordTrackingHit(
  emailId: string,
  hit:
    | { type: "opened"; headers: Headers }
    | { type: "clicked"; headers: Headers; url: string },
): Promise<void> {
  try {
    const [e] = await db().select().from(emails).where(eq(emails.id, emailId));
    if (!e) return;
    if (hit.type === "opened" ? !e.trackOpens : !e.trackClicks) return;
    const { ip, userAgent } = requestMeta(hit.headers);
    const ua = userAgent ?? "";
    const day = today();
    const dedupeKey =
      hit.type === "opened"
        ? `open:${sha256(ua).slice(0, 12)}:${day}`
        : `click:${sha256(hit.url + ua).slice(0, 16)}:${day}`;
    const payload =
      hit.type === "opened"
        ? { ip, userAgent }
        : { url: hit.url, ip, userAgent };
    const row = await recordEvent({
      emailId: e.id,
      teamId: e.teamId,
      type: hit.type,
      dedupeKey,
      payload,
    });
    if (!row) return;
    await fanOutEvent(
      e.teamId,
      `email.${hit.type}`,
      row.id,
      {
        email: publicEmail(e),
        event: {
          type: hit.type,
          occurredAt: row.occurredAt.toISOString(),
          ...payload,
        },
      },
      { enqueue },
    );
  } catch (err) {
    console.error(`[tracking] ${hit.type} ${emailId}:`, err);
  }
}
