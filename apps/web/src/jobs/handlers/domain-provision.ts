import { registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { provisionDomain } from "@/services/domains";

registerQueue<{ domainId: string }>(
  Q.domainProvision,
  async (jobs) => {
    for (const job of jobs)
      await provisionDomain(job.data.domainId, { enqueue });
  },
  {
    queue: {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 300,
    },
  },
);
