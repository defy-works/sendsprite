import { registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { sendQueuedEmail } from "@/services/ses-send";

registerQueue<{ emailId: string }>(
  Q.emailSend,
  async (jobs) => {
    for (const job of jobs)
      await sendQueuedEmail(
        job.data.emailId,
        { enqueue },
        // pg-boss bumps retryCount on each re-fetch, so the attempt where it
        // has reached retryLimit is the last one: a retryable SES error there
        // marks the email `failed` instead of reverting it to `queued`.
        { finalAttempt: job.retryCount >= job.retryLimit },
      );
  },
  {
    includeMetadata: true,
    queue: {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 120,
    },
  },
);
