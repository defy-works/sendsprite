import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import http from "node:http";
import { eq } from "drizzle-orm";
import { webhookDeliveries } from "@/db/schema";
import { startPg, type TestPg } from "./_pg";

/**
 * The retry loop through a real pg-boss. `webhook.deliver` is `exclusive`,
 * so a deliver job that enqueued its own retry while still `active` would
 * have that send dropped by the unique key index and every failed delivery
 * would stall after attempt 1. Retries are driven by the sweep instead;
 * this proves a second and third attempt actually run on the worker.
 */
let pg: TestPg;
let status = 500;
let endpoint: http.Server;
let port = 0;
const calls: string[] = [];
// The handler calls deliver() without a fetch seam, so the real pinned
// connection is made: DNS is stubbed to loopback (below) and the endpoint is
// a local listener, which the address vetting would otherwise refuse.
vi.mock("@/lib/url-safety", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/url-safety")>();
  return { ...mod, isPublicIp: () => true };
});
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
  ms = 30_000,
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
const load = async (id: string) => {
  const [d] = await pg.db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, id));
  if (!d) throw new Error("delivery missing");
  return d;
};

beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  // Starting the worker imports every job handler, and `billing-meter.ts`
  // reads the env at module scope. This file used to pass only when another
  // test in the same worker process had already set APP_URL.
  process.env.APP_URL ??= "http://localhost:3000";
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
  vi.spyOn(dns.promises, "lookup").mockImplementation(
    async () => [{ address: "127.0.0.1", family: 4 }] as never,
  );
  endpoint = http.createServer((req, res) => {
    calls.push(req.url ?? "");
    res.writeHead(status).end("resp");
  });
  await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
  port = (endpoint.address() as { port: number }).port;
});
afterAll(async () => {
  vi.restoreAllMocks();
  const { stopWorker } = await import("@/jobs/boss");
  await stopWorker();
  await new Promise<void>((r) => endpoint.close(() => r()));
  await pg.stop();
});

describe("webhook retries through pg-boss", () => {
  it("fails on the worker, the sweep drives attempt 2 under the exclusive policy, then a fixed endpoint gets delivered", async () => {
    const { startWorker, getWorkerState } = await import("@/jobs/boss");
    const { enqueue } = await import("@/jobs/enqueue");
    const { createWebhook, fanOutEvent } = await import("@/services/webhooks");
    const { sweepWebhookRetries } =
      await import("@/jobs/handlers/webhook-deliver");
    await startWorker();
    expect(getWorkerState()).toBe("running");

    const w = await createWebhook(actor, {
      // Pinned to loopback; the name itself never resolves.
      url: `http://hooks.acme.test:${port}/loop`,
      events: ["email.delivered"],
    });
    if (!w.ok) throw new Error(w.error);
    const [id] = await fanOutEvent(
      "org_1",
      "email.delivered",
      "evt_loop",
      { n: 1 },
      { enqueue },
    );
    if (!id) throw new Error("no delivery");

    // Attempt 1 runs on the worker and fails; the retry is only scheduled.
    const first = await until(
      "attempt 1",
      () => load(id),
      (d) => d.attempt === 1,
    );
    expect(first).toMatchObject({ status: "pending", statusCode: 500 });
    expect(first.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(calls).toHaveLength(1);

    // Not due yet: the sweep enqueues nothing.
    expect(await sweepWebhookRetries()).toBe(0);
    // Due (clock moved past the 60 s floor): the deliver job is completed,
    // so the exclusive key is free and the send goes through — attempt 2
    // actually executes on the worker.
    expect(await sweepWebhookRetries(new Date(Date.now() + 61_000))).toBe(1);
    const second = await until(
      "attempt 2",
      () => load(id),
      (d) => d.attempt === 2,
    );
    expect(second).toMatchObject({ status: "pending", statusCode: 500 });
    expect(calls).toHaveLength(2);

    // Endpoint fixed: the next sweep (past the 5 m floor) delivers it.
    status = 200;
    expect(await sweepWebhookRetries(new Date(Date.now() + 301_000))).toBe(1);
    const third = await until(
      "delivered",
      () => load(id),
      (d) => d.status === "delivered",
    );
    expect(third).toMatchObject({ attempt: 3, statusCode: 200 });
    expect(third.nextRetryAt).toBeNull();
    expect(calls).toHaveLength(3);
    // Nothing pending: a far-future sweep is a no-op.
    expect(await sweepWebhookRetries(new Date(Date.now() + 9e6))).toBe(0);
  });
});
