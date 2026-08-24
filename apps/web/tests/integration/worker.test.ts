import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg, type TestPg } from "./_pg";

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} not done in ${ms}ms`)), ms);
    t.unref();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// Tests are ordered: health is probed before any worker start (no pgboss
// schema yet), then the worker is started, then stopped.
describe("worker", () => {
  let pg: TestPg;
  let boss: typeof import("@/jobs/boss");
  let health: typeof import("@/lib/health");

  beforeAll(async () => {
    pg = await startPg();
    boss = await import("@/jobs/boss");
    health = await import("@/lib/health");
  });

  afterAll(async () => {
    await boss.stopWorker();
    await pg.stop();
  });

  it("health reports disabled worker and zero lag without pgboss schema", async () => {
    const h = await health.collect();
    expect(h).toMatchObject({
      db: "ok",
      worker: "disabled",
      queueLag: 0,
      status: "ok",
    });
  });

  it("runs handlers registered before start and reports running", async () => {
    const echo = deferred<unknown>();
    boss.registerQueue<{ hello: string }>("test.echo", async (jobs) => {
      echo.resolve(jobs[0]?.data);
    });

    await Promise.all([boss.startWorker(), boss.startWorker()]);
    expect(boss.getWorkerState()).toBe("running");

    const b = await boss.getBoss();
    expect(await b.send("test.echo", { hello: "world" })).toBeTruthy();
    await expect(within(echo.promise, 10_000, "echo job")).resolves.toEqual({
      hello: "world",
    });
  });

  it("registers the hourly SES account refresh queue on start", async () => {
    const b = await boss.getBoss();
    expect(await b.getQueue("ses.refresh-account")).toMatchObject({
      retryLimit: 0,
    });
  });

  it("runs handlers registered after start", async () => {
    const late = deferred<unknown>();
    boss.registerQueue<{ n: number }>("test.late", async (jobs) => {
      late.resolve(jobs[0]?.data);
    });
    const b = await boss.getBoss();
    // The queue is created asynchronously; retry send until it exists.
    await within(
      (async () => {
        for (;;) {
          try {
            await b.send("test.late", { n: 1 });
            return;
          } catch {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      })(),
      10_000,
      "late queue send",
    );
    await expect(within(late.promise, 10_000, "late job")).resolves.toEqual({
      n: 1,
    });
  });

  it("registerQueue passes queue options to pg-boss", async () => {
    boss.registerQueue("test.opts", async () => {}, {
      queue: {
        retryLimit: 7,
        retryDelay: 3,
        retryBackoff: true,
        expireInSeconds: 120,
      },
    });
    const b = await boss.getBoss();
    // attach is fire-and-forget after start; wait for the queue to exist
    let q = await b.getQueue("test.opts");
    for (let i = 0; !q && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      q = await b.getQueue("test.opts");
    }
    expect(q).toMatchObject({
      retryLimit: 7,
      retryDelay: 3,
      retryBackoff: true,
      expireInSeconds: 120,
    });
  });

  it("health reports db ok and worker running", async () => {
    const h = await health.collect();
    expect(h).toMatchObject({ db: "ok", worker: "running", status: "ok" });
    expect(h.queueLag).toBeGreaterThanOrEqual(0);
  });

  it("stopWorker flips state to stopped", async () => {
    await boss.stopWorker();
    expect(boss.getWorkerState()).toBe("stopped");
  });
});
