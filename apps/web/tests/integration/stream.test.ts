import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPg } from "./_pg";

// The SSE route resolves the team from the session; the test is about the
// stream, so hand it a fixed team.
vi.mock("@/lib/session", () => ({
  requireTeam: async () => ({ team: { id: "org_1" } }),
}));

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
async function until(cond: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await wait(20);
  return cond();
}

describe("team stream", () => {
  it("listenTeam receives notifyTeam payloads for its team only; unsubscribe stops it", async () => {
    const { listenTeam, listenerCount, notifyTeam } =
      await import("@/lib/notify");
    const got: string[] = [];
    const unlisten = await listenTeam("org_1", (p) => got.push(p));
    expect(listenerCount("org_1")).toBe(1);
    await notifyTeam("org_1", { type: "email", id: "em_1" });
    await notifyTeam("org_2", { type: "email", id: "em_2" });
    expect(await until(() => got.length > 0)).toBe(true);
    expect(got).toEqual([JSON.stringify({ type: "email", id: "em_1" })]);
    await unlisten();
    await unlisten(); // idempotent
    expect(listenerCount("org_1")).toBe(0);
    await notifyTeam("org_1", { type: "email", id: "em_3" });
    await wait(300);
    expect(got).toHaveLength(1);
  });

  it("SSE route streams changes and tears down the subscription and timer on abort", async () => {
    const { listenerCount, notifyTeam } = await import("@/lib/notify");
    const { GET } = await import("@/app/api/stream/route");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const ac = new AbortController();
    const res = await GET(
      new Request("http://localhost/api/stream", { signal: ac.signal }),
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const read = async () => dec.decode((await reader.read()).value);
    expect(await read()).toBe(": connected\n\n");
    expect(listenerCount("org_1")).toBe(1);
    await notifyTeam("org_1", { type: "email", id: "em_9" });
    expect(await read()).toBe(
      `event: change\ndata: ${JSON.stringify({ type: "email", id: "em_9" })}\n\n`,
    );
    ac.abort();
    expect(await until(() => listenerCount("org_1") === 0)).toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
    expect((await reader.read()).done).toBe(true);
    // A second abort/cancel is a no-op.
    await reader.cancel();
    expect(clear).toHaveBeenCalledTimes(1);
    clear.mockRestore();
  });
});
