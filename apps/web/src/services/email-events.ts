import { asc, eq } from "drizzle-orm";
import { newId } from "@sendsprite/shared";
import { db } from "@/db";
import {
  emailEvents,
  emails,
  type EmailEventType,
  type EmailStatus,
} from "@/db/schema";
import { notifyTeam } from "@/lib/notify";

export type EmailEvent = typeof emailEvents.$inferSelect;

/**
 * Status precedence. An event only moves the email forward: a late
 * `delivered` after a `bounced` is recorded on the timeline but leaves the
 * status alone, while `sent` arriving after `delivered` (SNS is unordered)
 * never regresses it.
 */
const TERMINAL_RANK: Record<string, number> = {
  queued: 0,
  scheduled: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  delivery_delayed: 2,
  bounced: 4,
  complained: 5,
  rejected: 4,
  failed: 4,
  cancelled: 4,
};

const STATUS_FOR: Partial<Record<EmailEventType, EmailStatus>> = {
  sent: "sent",
  delivered: "delivered",
  bounced: "bounced",
  complained: "complained",
  rejected: "failed",
  failed: "failed",
  cancelled: "cancelled",
};

/**
 * Idempotent insert keyed by `(emailId, dedupeKey)`; updates the email
 * status when the event outranks the current one. Returns the row, or null
 * when the event was already recorded (SNS redelivery).
 */
export async function recordEvent(i: {
  emailId: string;
  teamId: string;
  type: EmailEventType;
  dedupeKey: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}): Promise<EmailEvent | null> {
  const occurredAt = i.occurredAt ?? new Date();
  const [row] = await db()
    .insert(emailEvents)
    .values({
      id: newId("evt"),
      emailId: i.emailId,
      teamId: i.teamId,
      type: i.type,
      dedupeKey: i.dedupeKey,
      payload: i.payload ?? {},
      occurredAt,
    })
    .onConflictDoNothing({
      target: [emailEvents.emailId, emailEvents.dedupeKey],
    })
    .returning();
  if (!row) return null;
  const next = STATUS_FOR[i.type];
  if (next) {
    const [cur] = await db()
      .select({ status: emails.status })
      .from(emails)
      .where(eq(emails.id, i.emailId));
    if (cur && (TERMINAL_RANK[next] ?? 0) >= (TERMINAL_RANK[cur.status] ?? 0))
      await db()
        .update(emails)
        .set({
          status: next,
          ...(next === "sent" && { sentAt: occurredAt }),
        })
        .where(eq(emails.id, i.emailId));
  }
  await notifyTeam(i.teamId, { type: "email", id: i.emailId });
  return row;
}

/** Timeline, oldest first. */
export const listEvents = (emailId: string): Promise<EmailEvent[]> =>
  db()
    .select()
    .from(emailEvents)
    .where(eq(emailEvents.emailId, emailId))
    .orderBy(asc(emailEvents.occurredAt), asc(emailEvents.id));
