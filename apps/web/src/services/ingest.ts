import { eq } from "drizzle-orm";
import { db } from "@/db";
import { emails, type EmailEventType } from "@/db/schema";
import { parseSesEvent } from "@/lib/ses-events";
import { recordEvent } from "./email-events";
import { suppressFromEvent } from "./suppressions";
import { fanOutEvent } from "./webhooks";
import type { Enqueue } from "./domains";

/** Timeline types that fan out to webhooks; the rest are timeline-only. */
const WEBHOOK_TYPE: Partial<Record<EmailEventType, string>> = {
  sent: "email.sent",
  delivered: "email.delivered",
  delivery_delayed: "email.delayed",
  bounced: "email.bounced",
  complained: "email.complained",
  rejected: "email.failed",
  failed: "email.failed",
};

export type IngestResult =
  { ok: true; recorded: boolean } | { ok: false; reason: string };

/**
 * One SES event (the parsed SNS `Message`) → timeline event, status,
 * suppressions, webhook fan-out. Attribution is by the `ss_email` tag,
 * then by `ses_message_id`. Idempotent per SNS message id (SNS delivers
 * at least once): a redelivery reports `recorded: false` and does nothing
 * else. Open/Click from SES are acknowledged but ignored — our own
 * tracking endpoints are the one source for those.
 */
export async function ingestSesEvent(
  raw: unknown,
  snsMessageId: string,
  deps: { enqueue: Enqueue },
): Promise<IngestResult> {
  const ev = parseSesEvent(raw);
  if (!ev) return { ok: false, reason: "unparseable_or_unsupported" };
  if (ev.type === "opened" || ev.type === "clicked")
    return { ok: true, recorded: false };
  const [e] = ev.emailId
    ? await db().select().from(emails).where(eq(emails.id, ev.emailId))
    : await db()
        .select()
        .from(emails)
        .where(eq(emails.sesMessageId, ev.sesMessageId));
  if (!e) return { ok: false, reason: "unknown_email" };
  const row = await recordEvent({
    emailId: e.id,
    teamId: e.teamId,
    type: ev.type,
    dedupeKey: `sns:${snsMessageId}`,
    payload: { ...ev.payload, recipients: ev.recipients },
    occurredAt: ev.occurredAt,
  });
  if (!row) return { ok: true, recorded: false };
  // A `Send` event can beat the send job's own bookkeeping of the message id.
  if (ev.type === "sent" && !e.sesMessageId)
    await db()
      .update(emails)
      .set({ sesMessageId: ev.sesMessageId })
      .where(eq(emails.id, e.id));
  await suppressFromEvent(e.teamId, ev.suppress, e.id);
  const wt = WEBHOOK_TYPE[ev.type];
  if (wt)
    await fanOutEvent(
      e.teamId,
      wt,
      row.id,
      {
        email: publicEmail(e),
        event: {
          type: ev.type,
          occurredAt: ev.occurredAt.toISOString(),
          ...ev.payload,
          recipients: ev.recipients,
        },
      },
      deps,
    );
  return { ok: true, recorded: true };
}

/** The email as webhook consumers see it: no body, headers or internals. */
export const publicEmail = (e: typeof emails.$inferSelect) => ({
  id: e.id,
  from: e.from,
  to: e.to,
  cc: e.cc,
  bcc: e.bcc,
  replyTo: e.replyTo,
  subject: e.subject,
  status: e.status,
  tags: e.tags,
  createdAt: e.createdAt.toISOString(),
  sentAt: e.sentAt?.toISOString() ?? null,
  scheduledAt: e.scheduledAt?.toISOString() ?? null,
  lastError: e.lastError,
});
