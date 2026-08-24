import { registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { verifyDomain } from "@/services/domains";

registerQueue<{ domainId: string }>(
  Q.domainVerify,
  async (jobs) => {
    for (const job of jobs) await verifyDomain(job.data.domainId, { enqueue });
  },
  {
    // `exclusive`: pg-boss 12 keeps one job per (queue, singletonKey) across
    // created/retry/active (unique index job_i6, `state <= 'active'`); a
    // duplicate `send` returns null. On the default `standard` policy a bare
    // singletonKey dedups nothing. Every verify send keys on the domain id,
    // so Re-verify plus the running loop never fan out into two loops.
    queue: {
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 60,
      expireInSeconds: 120,
    },
  },
);
