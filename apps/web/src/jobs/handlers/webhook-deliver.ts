import { registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { deliver } from "@/services/webhooks";

// Retries follow the service's own schedule (`deliver` re-enqueues with a
// delay), so pg-boss must not add its own. A single attempt is bounded by
// the 10 s request timeout, well under the 60 s expiry.
registerQueue<{ deliveryId: string }>(
  Q.webhookDeliver,
  async (jobs) => {
    for (const job of jobs) await deliver(job.data.deliveryId, { enqueue });
  },
  { queue: { retryLimit: 0, expireInSeconds: 60 } },
);
