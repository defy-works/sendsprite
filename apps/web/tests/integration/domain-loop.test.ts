import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SESv2Client,
  CreateEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
  GetEmailIdentityCommand,
} from "@aws-sdk/client-sesv2";
import { eq, sql } from "drizzle-orm";
import { domains } from "@/db/schema";
import { startPg, type TestPg } from "./_pg";
import { connectTeamAws } from "./helpers";

/**
 * The verify loop through a real pg-boss: provisioning runs as a job, the
 * sweep enqueues `domain.verify` under the exclusive policy, and the worker
 * runs it — twice. This is the regression test for the self-chaining
 * design, where a verify job re-enqueued itself while still `active` and
 * the exclusive index dropped the insert after the first iteration.
 */
const ses = mockClient(SESv2Client);
let pg: TestPg;
const actor = {
  userId: "u1",
  teamId: "org_1",
  teamName: "Acme",
  role: "owner" as const,
};

async function until<T>(
  what: string,
  read: () => Promise<T>,
  ok: (v: T) => boolean,
  // 60s, not 30: this drives real pg-boss polling through a sweep cron, and a
  // shared CI runner reached the first verify at 32.8s — a flake that failed
  // the Phase 6 tag build and passed on re-run. The assertions are unchanged;
  // only the patience is. A genuinely stuck loop still reports which step it
  // did not reach, because the vitest timeout for this project is 120s.
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline)
      throw new Error(`${what} not reached in ${ms}ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
/**
 * Wait until no `domain.verify` job is queued or running.
 *
 * `sweepDomainVerification()` enqueues under an exclusive policy, so it
 * answers 0 while a job with the same key is still `created` or `active`.
 * Observing `lastCheckedAt` is not enough: the handler writes that row and
 * then returns, and the job stays `active` until pg-boss settles it. The gap
 * is small on a quiet machine and wide on a loaded CI runner — and Phase 7
 * added three more crons to the same worker, which widened it further.
 */
const verifyJobsSettled = async () => {
  const rows = await pg.db.execute(
    sql`select count(*)::int as n from pgboss.job where name = 'domain.verify' and state in ('created','active')`,
  );
  const row = (
    Array.isArray(rows) ? rows[0] : (rows as { rows: unknown[] }).rows[0]
  ) as { n: number };
  return row.n;
};

const load = async (id: string) => {
  const [d] = await pg.db.select().from(domains).where(eq(domains.id, id));
  if (!d) throw new Error("domain missing");
  return d;
};

beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  delete process.env.AWS_E2E_MOCK;
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
  await connectTeamAws("org_1", {
    region: "eu-west-1",
    configSet: "sendsprite",
  });
  ses.on(CreateEmailIdentityCommand).resolves({
    DkimAttributes: { Tokens: ["t1", "t2", "t3"], Status: "PENDING" },
  });
  ses.on(PutEmailIdentityMailFromAttributesCommand).resolves({});
  ses.on(GetEmailIdentityCommand).resolves({
    DkimAttributes: { Status: "PENDING", Tokens: ["t1", "t2", "t3"] },
    MailFromAttributes: {
      MailFromDomain: "bounce.x",
      MailFromDomainStatus: "PENDING",
      BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
    },
  });
});
afterAll(async () => {
  const { stopWorker } = await import("@/jobs/boss");
  await stopWorker();
  await pg.stop();
});

// Ordered: the send-only process comes first, on a database with no pgboss
// schema yet, then the worker takes over the same database.
describe("domain verification through pg-boss", () => {
  it("a process that never started the worker can still send", async () => {
    const { getBoss, getWorkerState } = await import("@/jobs/boss");
    const b = await getBoss();
    expect(getWorkerState()).toBe("disabled");
    // The queue exists although no handler was attached here.
    expect(await b.getQueue("domain.provision")).toMatchObject({
      retryLimit: 5,
    });
    expect(await b.getQueue("domain.verify-sweep")).toBeTruthy();
    // The job runs (and no-ops on the unknown id) once the worker starts.
    expect(await b.send("domain.provision", { domainId: "dom_nope" })).toMatch(
      /./,
    );
  });

  it("provisions, then the sweep drives two verify runs under the exclusive policy", async () => {
    const { startWorker, getWorkerState } = await import("@/jobs/boss");
    const { enqueue } = await import("@/jobs/enqueue");
    const { createDomain } = await import("@/services/domains");
    const { sweepDomainVerification } =
      await import("@/jobs/handlers/domain-verify");
    await startWorker();
    expect(getWorkerState()).toBe("running");

    const res = await createDomain(
      actor,
      { name: "loop.acme.com" },
      { enqueue },
    );
    if (!res.ok) throw new Error(res.error);
    const id = res.data.id;
    expect(res.data.lastError).toBeNull();
    await until(
      "provisioned",
      () => load(id),
      (d) => d.dkimTokens.length > 0,
    );

    // Provisioning queued the first verify 30 s out; pull it forward so the
    // test does not wait, then let the worker run it.
    await pg.db.execute(
      sql`update pgboss.job set start_after = now() where name = 'domain.verify' and state = 'created'`,
    );
    const first = await until(
      "first verify",
      () => load(id),
      (d) => d.lastCheckedAt !== null,
    );
    expect(first.status).toBe("pending");

    // Sweep #1: wait for the previous verify job to actually settle — not just
    // for the row it wrote — so the exclusive key is free and the send goes
    // through.
    await until("first verify settled", verifyJobsSettled, (n) => n === 0);
    await pg.db
      .update(domains)
      .set({ lastCheckedAt: new Date(Date.now() - 200_000) })
      .where(eq(domains.id, id));
    expect(await sweepDomainVerification()).toBe(1);
    const second = await until(
      "second verify",
      () => load(id),
      (d) => d.lastCheckedAt!.getTime() > Date.now() - 100_000,
    );

    // Sweep #2: same again — the loop keeps going.
    await until("second verify settled", verifyJobsSettled, (n) => n === 0);
    await pg.db
      .update(domains)
      .set({ lastCheckedAt: new Date(Date.now() - 200_000) })
      .where(eq(domains.id, id));
    expect(await sweepDomainVerification()).toBe(1);
    const third = await until(
      "third verify",
      () => load(id),
      (d) => d.lastCheckedAt!.getTime() > second.lastCheckedAt!.getTime(),
    );
    expect(third.status).toBe("pending");
    // Not stale any more: a sweep right now enqueues nothing.
    expect(await sweepDomainVerification()).toBe(0);
    expect(
      ses.commandCalls(GetEmailIdentityCommand).length,
    ).toBeGreaterThanOrEqual(3);
  });
});
