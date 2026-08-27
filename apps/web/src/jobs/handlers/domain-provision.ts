import { isFinalAttempt, registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { provisionDomain } from "@/services/domains";

registerQueue<{ domainId: string }>(
  Q.domainProvision,
  async (jobs) => {
    for (const job of jobs)
      await provisionDomain(
        job.data.domainId,
        { enqueue },
        // A terminal failure marks the domain `failed` (Retry provisioning re-sends).
        { finalAttempt: isFinalAttempt(job) },
      );
  },
  {
    includeMetadata: true,
    queue: {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 300,
    },
  },
);
