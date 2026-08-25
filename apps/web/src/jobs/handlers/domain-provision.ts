import { registerQueue } from "../boss";
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
        // pg-boss bumps retryCount on each re-fetch, so the final attempt is
        // the one where it has reached retryLimit; that attempt's failure is
        // terminal and marks the domain `failed` (Retry provisioning re-sends).
        { finalAttempt: job.retryCount >= job.retryLimit },
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
