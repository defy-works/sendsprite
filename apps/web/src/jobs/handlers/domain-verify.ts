import { registerQueue } from "../boss";
import { Q } from "../queues";
import { verifyDomain } from "@/services/domains";
import { enqueue } from "./domain-provision";

registerQueue<{ domainId: string }>(
  Q.domainVerify,
  async (jobs) => {
    for (const job of jobs) await verifyDomain(job.data.domainId, { enqueue });
  },
  { queue: { retryLimit: 3, retryDelay: 60, expireInSeconds: 120 } },
);
