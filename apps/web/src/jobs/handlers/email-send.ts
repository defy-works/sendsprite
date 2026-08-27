import { isFinalAttempt, registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import {
  reconcileStuckSending,
  sendQueuedEmail,
  sweepQueuedEmails,
} from "@/services/ses-send";

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
registerQueue(Q.emailReconcile, () => reconcileStuckSending({ enqueue }), {
  cron: "*/5 * * * *",
  // retryLimit 0: a failed sweep is simply retried by the next tick.
  queue: { retryLimit: 0 },
});

// Re-sends `email.send` for due queued/scheduled rows whose job was lost
// (see `sweepQueuedEmails`). `email.send` is a standard-policy queue, so a
// duplicate job is allowed and the atomic claim makes it a no-op.
registerQueue(Q.emailQueuedSweep, () => sweepQueuedEmails({ enqueue }), {
  cron: "*/2 * * * *",
  queue: { retryLimit: 0 },
});
