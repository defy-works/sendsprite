import { registerQueue } from "../boss";
import { enqueue } from "../enqueue";
import { Q } from "../queues";
import { selectSweepCandidates, verifyDomain } from "@/services/domains";

registerQueue<{ domainId: string; force?: boolean }>(
  Q.domainVerify,
  async (jobs) => {
    for (const job of jobs)
      await verifyDomain(
        job.data.domainId,
        { enqueue },
        { force: job.data.force ?? false },
      );
  },
  {
    // `exclusive`: pg-boss 12 keeps one job per (queue, singletonKey) across
    // created/retry/active (unique index job_i6, `state <= 'active'`); a
    // duplicate `send` returns null. On the default `standard` policy a bare
    // singletonKey dedups nothing. Every verify send keys on the domain id,
    // so the sweep plus a still-queued job never fan out into two runs.
    //
    // That same index is why a verify job must not re-enqueue itself: while
    // it is `active` its own key is taken and the insert is dropped, so the
    // loop would end after one iteration. The sweep below drives the loop
    // from outside any verify job instead.
    queue: {
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 60,
      expireInSeconds: 120,
    },
  },
);

/**
 * Cron: enqueue one `domain.verify` per pending, provisioned domain whose
 * last check is older than ~100 s (so a 2-minute cron re-checks every
 * tick, and a job still queued/active is deduped by the exclusive key).
 * Expired rows stay in the set: `verifyDomain` marks them `failed` on the
 * next run, which removes them. Verified domains unchecked for 24 h are
 * sent with `force: true` so the check runs (and demotes on SES
 * disagreement). Exported so tests can drive it directly. Returns the
 * number of domains enqueued.
 */
export async function sweepDomainVerification(): Promise<number> {
  const candidates = await selectSweepCandidates();
  let sent = 0;
  for (const { id: domainId, force } of candidates) {
    const job = await enqueue(
      Q.domainVerify,
      { domainId, ...(force && { force }) },
      { singletonKey: domainId },
    );
    if (job) sent++;
  }
  return sent;
}

registerQueue(Q.domainVerifySweep, () => sweepDomainVerification(), {
  cron: "*/2 * * * *",
  // retryLimit 0: a failed sweep is simply retried by the next tick.
  queue: { retryLimit: 0 },
});
