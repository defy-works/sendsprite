import { and, eq } from "drizzle-orm";
import type { WebhookEventType } from "@sendsprite/shared";
import { db } from "@/db";
import { emails, type EmailEventType } from "@/db/schema";
import { parseSesEvent } from "@/lib/ses-events";
import { recordEvent } from "./email-events";
import { suppressFromEvent } from "./suppressions";
import { fanOutEvent } from "./webhooks";
import { settleCampaign } from "./campaigns/stats";
import type { Enqueue } from "./domains";

/**
 * Event types after which a campaign message is owed nothing further.
 *
 * The only events worth asking "did that finish the campaign?" about. `sent`
 * and `delivery_delayed` both leave the recipient outstanding, so a campaign
 * cannot have completed on one of them and the check is skipped outright.
 */
const TERMINAL_FOR_CAMPAIGN: ReadonlySet<EmailEventType> = new Set([
  "delivered",
  "bounced",
  "complained",
  "rejected",
  "failed",
]);

/** Timeline types that fan out to webhooks; the rest are timeline-only. */
const WEBHOOK_TYPE: Partial<Record<EmailEventType, WebhookEventType>> = {
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
 * suppressions, webhook fan-out. Attribution is by the `ss_email` tag, then
 * by `ses_message_id`, and **always within `teamId`** — the team whose SNS
 * topic the event arrived on.
 *
 * The team predicate is load-bearing, not defensive. Every tenant runs its
 * own AWS account and can put whatever it likes in an `ss_email` tag, so
 * without it tenant A could name tenant B's email id and write events,
 * status changes and suppressions into B's timeline.
 *
 * Idempotent per SNS message id (SNS delivers at least once): a redelivery
 * reports `recorded: false` and does nothing else. Open/Click from SES are
 * acknowledged but ignored — our own tracking endpoints are the one source
 * for those.
 */
export async function ingestSesEvent(
  teamId: string,
  raw: unknown,
  snsMessageId: string,
  deps: { enqueue: Enqueue },
): Promise<IngestResult> {
  const ev = parseSesEvent(raw);
  if (!ev) return { ok: false, reason: "unparseable_or_unsupported" };
  if (ev.type === "opened" || ev.type === "clicked")
    return { ok: true, recorded: false };
  const [e] = ev.emailId
    ? await db()
        .select()
        .from(emails)
        .where(and(eq(emails.teamId, teamId), eq(emails.id, ev.emailId)))
    : await db()
        .select()
        .from(emails)
        .where(
          and(
            eq(emails.teamId, teamId),
            eq(emails.sesMessageId, ev.sesMessageId),
          ),
        );
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
      { ...deps, createdAt: row.occurredAt },
    );
  if (e.campaignId && TERMINAL_FOR_CAMPAIGN.has(ev.type))
    await nudgeCampaign(e.teamId, e.campaignId, deps);
  return { ok: true, recorded: true };
}

/**
 * Ask whether that event was the one that finished the campaign.
 *
 * **Nothing here increments a counter** (Decision 8). The campaign's numbers
 * stay derived; this only notices a condition, and `settleCampaign` stages the
 * work so that noticing costs two indexed lookups — the aggregate runs once
 * per campaign, not once per event. A campaign that has already completed
 * costs one read and stops.
 *
 * Best-effort, and it never fails an ingest: the event is already recorded and
 * the SNS delivery already acknowledged by the time this runs, so a throw here
 * would make SES redeliver an event we have — and the settle pass would notice
 * the same condition a minute later regardless.
 */
async function nudgeCampaign(
  teamId: string,
  campaignId: string,
  deps: { enqueue: Enqueue },
): Promise<void> {
  try {
    await settleCampaign(teamId, campaignId, deps);
  } catch (e) {
    console.error("[ingest] campaign settle failed:", (e as Error).message);
  }
}

/** Columns `publicEmail` reads; callers may select just these. */
export type PublicEmailRow = Pick<
  typeof emails.$inferSelect,
  | "id"
  | "from"
  | "to"
  | "cc"
  | "bcc"
  | "replyTo"
  | "subject"
  | "status"
  | "tags"
  | "createdAt"
  | "sentAt"
  | "scheduledAt"
  | "lastError"
>;

/** The email as webhook consumers see it: no body, headers or internals. */
export const publicEmail = (e: PublicEmailRow) => ({
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
