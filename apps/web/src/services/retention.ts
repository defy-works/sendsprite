import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { emailAttachments, emails, webhookDeliveries } from "@/db/schema";

/**
 * Nightly retention for one team (spec §5): emails created more than
 * `retentionDays` ago
 * lose their bodies (`html`/`text`/`variables` nulled, attachment bytes
 * deleted, `bodyPurgedAt` stamped); the row, metadata and events stay. Webhook
 * deliveries older than the same window are deleted outright (their
 * payloads and response excerpts only matter for recent debugging).
 * Batched so one nightly run never holds a long lock; idempotent because
 * purged emails are excluded by `bodyPurgedAt`. Returns the counts.
 */
export async function purgeOldBodies(
  teamId: string,
  retentionDays: number,
  now = new Date(),
  batch = 500,
): Promise<{ emails: number; deliveries: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  let purged = 0;
  for (;;) {
    const ids = (
      await db()
        .select({ id: emails.id })
        .from(emails)
        .where(
          and(
            eq(emails.teamId, teamId),
            isNull(emails.bodyPurgedAt),
            lt(emails.createdAt, cutoff),
          ),
        )
        .orderBy(emails.createdAt)
        .limit(batch)
    ).map((r) => r.id);
    if (ids.length === 0) break;
    await db().transaction(async (tx) => {
      await tx
        .delete(emailAttachments)
        .where(inArray(emailAttachments.emailId, ids));
      await tx
        .update(emails)
        // `variables` holds whatever the caller substituted into the body, so
        // it is body content and is purged with it.
        .set({ html: null, text: null, variables: null, bodyPurgedAt: now })
        .where(and(inArray(emails.id, ids), isNull(emails.bodyPurgedAt)));
    });
    purged += ids.length;
    if (ids.length < batch) break;
  }
  const deleted = await db()
    .delete(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.teamId, teamId),
        lt(webhookDeliveries.createdAt, cutoff),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return { emails: purged, deliveries: deleted.length };
}
