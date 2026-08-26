import { registerQueue } from "../boss";
import { Q } from "../queues";
import { getInstanceSettings } from "@/services/instance-settings";
import { purgeOldBodies } from "@/services/retention";

/**
 * Cron: purge bodies/attachments and old webhook deliveries past
 * `instance_settings.retention_days` (the only source of the window; there
 * is no env override). Exported so tests can drive it directly.
 */
export async function runRetentionPurge() {
  const { retentionDays } = await getInstanceSettings();
  const purged = await purgeOldBodies(retentionDays);
  console.info(
    `[retention] purged ${purged.emails} email bodies, ${purged.deliveries} webhook deliveries (> ${retentionDays} d)`,
  );
  return purged;
}

registerQueue(Q.retentionPurge, () => runRetentionPurge(), {
  cron: "15 3 * * *",
  // retryLimit 0: a failed run is simply retried the next night.
  queue: { retryLimit: 0 },
});
