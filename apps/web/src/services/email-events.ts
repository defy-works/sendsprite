import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { newId, EMAIL_STATUS } from "@sendsprite/shared";
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
 * status alone, `sent` arriving after `delivered` (SNS is unordered) never
 * regresses it, and `cancelled` only beats the pre-send states.
 */
const RANK: Record<EmailStatus, number> = {
  queued: 0,
  scheduled: 0,
  sending: 1,
  cancelled: 1,
  sent: 2,
  delivered: 3,
  bounced: 4,
  failed: 4,
  complained: 5,
};

/** Events that move the status; `delivery_delayed`/`opened`/`clicked` never do. */
const STATUS_FOR: Partial<Record<EmailEventType, EmailStatus>> = {
  sent: "sent",
  delivered: "delivered",
  bounced: "bounced",
  complained: "complained",
  rejected: "failed",
  failed: "failed",
  cancelled: "cancelled",
};

/** Statuses `next` may overwrite: everything ranked at or below it. */
const overtakes = (next: EmailStatus) =>
  EMAIL_STATUS.filter((s) => RANK[s] <= RANK[next]);

/**
 * Idempotent insert keyed by `(emailId, dedupeKey)`; advances the email
 * status in a single conditional UPDATE (no read-then-write, so concurrent
 * events cannot regress it). `sentAt` is set once, by the first `sent`.
 * Returns the row, or null when the event was already recorded (SNS
 * redelivery), in which case the status is left untouched.
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
  if (next)
    await db()
      .update(emails)
      .set({
        status: next,
        ...(next === "sent" && {
          sentAt: sql`coalesce(${emails.sentAt}, ${occurredAt.toISOString()}::timestamptz)`,
        }),
      })
      .where(
        and(eq(emails.id, i.emailId), inArray(emails.status, overtakes(next))),
      );
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
