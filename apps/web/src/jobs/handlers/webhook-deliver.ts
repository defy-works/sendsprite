import { registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { deliver, listDueRetries } from "@/services/webhooks";

registerQueue<{ deliveryId: string }>(
  Q.webhookDeliver,
  async (jobs) => {
    for (const job of jobs) await deliver(job.data.deliveryId, { enqueue });
  },
  {
    // `exclusive`: one job per (queue, singletonKey = delivery id) across
    // created/retry/active (unique index job_i6), so a Replay is deduped
    // against a queued retry. That same index means a deliver job must not
    // re-enqueue its own retry: while it is `active` its key is taken and
    // the insert is dropped, stalling every failed delivery after attempt 1.
    // The sweep below drives retries from outside any deliver job instead.
    // pg-boss retries stay off (retryLimit 0): the schedule is ours. A
    // single attempt is bounded by the 10 s request timeout, well under the
    // 60 s expiry.
    queue: { policy: "exclusive", retryLimit: 0, expireInSeconds: 60 },
  },
);

/**
 * Cron: enqueue one `webhook.deliver` per pending delivery whose
 * `nextRetryAt` has passed. A job still queued/active for that delivery is
 * deduped by the exclusive key. Exported so tests can drive it directly.
 * Returns the number of deliveries enqueued.
 */
export async function sweepWebhookRetries(now = new Date()): Promise<number> {
  const ids = await listDueRetries(now);
  let sent = 0;
  for (const deliveryId of ids) {
    const job = await enqueue(
      Q.webhookDeliver,
      { deliveryId },
      { singletonKey: deliveryId },
    );
    if (job) sent++;
  }
  return sent;
}

registerQueue(Q.webhookRetrySweep, () => sweepWebhookRetries(), {
  cron: "* * * * *",
  // retryLimit 0: a failed sweep is simply retried by the next tick.
  queue: { retryLimit: 0 },
});
