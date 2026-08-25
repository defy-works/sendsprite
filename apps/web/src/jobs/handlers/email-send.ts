import { isFinalAttempt, registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { reconcileStuckSending, sendQueuedEmail } from "@/services/ses-send";

registerQueue<{ emailId: string }>(
  Q.emailSend,
  async (jobs) => {
    for (const job of jobs)
      await sendQueuedEmail(
        job.data.emailId,
        { enqueue },
        // A retryable SES error on the last attempt marks the email `failed`
        // instead of reverting it to `queued`.
        { finalAttempt: isFinalAttempt(job) },
      );
  },
  {
    includeMetadata: true,
    queue: {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      // Above the SES client's 120 s request timeout + its retries.
      expireInSeconds: 300,
    },
  },
);

// Settles rows a crashed worker left in `sending` (see `reconcileStuckSending`).
registerQueue(Q.emailReconcile, () => reconcileStuckSending(), {
  cron: "*/5 * * * *",
  // retryLimit 0: a failed sweep is simply retried by the next tick.
  queue: { retryLimit: 0 },
});
