import { registerQueue, getBoss } from "../boss";
import { Q } from "../queues";
import { provisionDomain, type Enqueue } from "@/services/domains";

/**
 * Service → pg-boss bridge. `startAfter` stays a number of seconds: pg-boss
 * 12 stringifies a number and Postgres casts it to an interval.
 */
export const enqueue: Enqueue = async (queue, data, opts) =>
  (await getBoss()).send(
    queue,
    data,
    opts?.startAfter ? { startAfter: opts.startAfter } : undefined,
  );

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
