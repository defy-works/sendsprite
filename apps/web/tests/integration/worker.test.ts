import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg, type TestPg } from "./_pg";

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

  it("runs registered handlers and reports running", async () => {
    let resolveEcho!: (v: unknown) => void;
    const echoed = new Promise<unknown>((r) => (resolveEcho = r));
    boss.registerQueue("test.echo", async (jobs) => {
      resolveEcho(jobs[0]?.data);
    });

    expect(boss.getWorkerState()).toBe("disabled");
    await boss.startWorker();
    expect(boss.getWorkerState()).toBe("running");

    const b = await boss.getBoss();
    const id = await b.send("test.echo", { hello: "world" });
    expect(id).toBeTruthy();

    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("echo job not handled in 10s")),
        10_000,
      ),
    );
    await expect(Promise.race([echoed, timeout])).resolves.toEqual({
      hello: "world",
    });
  });

  it("health reports db ok and worker running", async () => {
    const h = await health.collect();
    expect(h.db).toBe("ok");
    expect(h.worker).toBe("running");
    expect(h.status).toBe("ok");
    expect(typeof h.queueLag).toBe("number");
  });

  it("stopWorker flips state to stopped", async () => {
    await boss.stopWorker();
    expect(boss.getWorkerState()).toBe("stopped");
  });
});
