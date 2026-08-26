import { eq } from "drizzle-orm";
import { registerQueue } from "../boss";
import { Q } from "../queues";
import { db } from "@/db";
import { organization, teamSettings } from "@/db/schema";
import { getInstanceSettings } from "@/services/instance-settings";
import { effectiveRetentionDays } from "@/services/retention-policy";
import { purgeOldBodies } from "@/services/retention";

/**
 * Cron: purge bodies/attachments and old webhook deliveries, per team, at
 * `min(team_settings.retention_days ?? max, max)` where `max` is
 * `instance_settings.retention_days`. One team's failure must not cost the
 * rest their nightly purge, so each is isolated. Exported so tests can drive
 * it directly.
 */
export async function runRetentionPurge(now = new Date()) {
  const { retentionDays: max } = await getInstanceSettings();
  const teams = await db()
    .select({ id: organization.id, days: teamSettings.retentionDays })
    .from(organization)
    .leftJoin(teamSettings, eq(teamSettings.teamId, organization.id));
  const total = { emails: 0, deliveries: 0 };
  for (const t of teams) {
    const days = effectiveRetentionDays(t.days ?? null, max);
    try {
      const purged = await purgeOldBodies(t.id, days, now);
      total.emails += purged.emails;
      total.deliveries += purged.deliveries;
    } catch (e) {
      console.warn(
        `[retention] team ${t.id} failed:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  console.info(
    `[retention] purged ${total.emails} email bodies, ${total.deliveries} webhook deliveries across ${teams.length} teams`,
  );
  return total;
}

registerQueue(Q.retentionPurge, () => runRetentionPurge(), {
  cron: "15 3 * * *",
  // retryLimit 0: a failed run is simply retried the next night.
  queue: { retryLimit: 0 },
});
