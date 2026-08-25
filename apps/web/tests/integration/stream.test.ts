import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  const { closeListener } = await import("@/lib/notify");
  await closeListener();
  await pg.stop();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("team stream", () => {
  it("listenTeam receives notifyTeam payloads for its team only; unsubscribe stops it", async () => {
    const { listenTeam, notifyTeam } = await import("@/lib/notify");
    const got: string[] = [];
    const unlisten = await listenTeam("org_1", (p) => got.push(p));
    await notifyTeam("org_1", { type: "email", id: "em_1" });
    await notifyTeam("org_2", { type: "email", id: "em_2" });
    const deadline = Date.now() + 2000;
    while (got.length === 0 && Date.now() < deadline) await wait(20);
    expect(got).toEqual([JSON.stringify({ type: "email", id: "em_1" })]);
    await unlisten();
    await notifyTeam("org_1", { type: "email", id: "em_3" });
    await wait(300);
    expect(got).toHaveLength(1);
  });
});
