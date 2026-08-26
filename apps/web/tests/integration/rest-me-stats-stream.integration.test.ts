import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as me } from "@/app/api/v1/me/route";
import { GET as stats } from "@/app/api/v1/stats/route";
import { GET as stream } from "@/app/api/v1/stream/route";
import { closeListener, notifyTeam } from "@/lib/notify";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await closeListener();
  await pg.stop();
});

const auth = (secret: string) => ({
  headers: { authorization: `Bearer ${secret}` },
});
const ctx = { params: Promise.resolve({}) };

describe("GET /api/v1/me", () => {
  it("returns the team and the calling key", async () => {
    const { team, key, secret } = await seedTeamWithKey();
    const r = await me(new Request("http://x/api/v1/me", auth(secret)), ctx);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      team: { id: team.id, name: team.name },
      apiKey: {
        id: key.id,
        name: key.name,
        permission: "full",
        keyPrefix: key.keyPrefix,
        domainId: null,
      },
    });
  });
  it("works for a sending-only key too", async () => {
    const { secret } = await seedTeamWithKey({ permission: "sending_only" });
    expect(
      (await me(new Request("http://x/api/v1/me", auth(secret)), ctx)).status,
    ).toBe(200);
  });
});

describe("GET /api/v1/stats", () => {
  it("returns SendStats for a full key and 403 for sending-only", async () => {
    const { secret } = await seedTeamWithKey();
    const r = await stats(
      new Request("http://x/api/v1/stats", auth(secret)),
      ctx,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ sent: { today: 0 }, alerts: [] });
    const { secret: s2 } = await seedTeamWithKey({
      permission: "sending_only",
    });
    expect(
      (await stats(new Request("http://x/api/v1/stats", auth(s2)), ctx)).status,
    ).toBe(403);
  });
});

describe("GET /api/v1/stream", () => {
  it("streams change events for the key's team until aborted", async () => {
    const { team, secret } = await seedTeamWithKey();
    const ac = new AbortController();
    const r = await stream(
      new Request("http://x/api/v1/stream", {
        ...auth(secret),
        signal: ac.signal,
      }),
      ctx,
    );
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    // first chunk is ": connected"
    buf += dec.decode((await reader.read()).value);
    expect(buf).toContain(": connected");
    await notifyTeam(team.id, { type: "email", id: "em_1" });
    const deadline = Date.now() + 5_000;
    while (!buf.includes("event: change") && Date.now() < deadline)
      buf += dec.decode((await reader.read()).value);
    expect(buf).toContain('data: {"type":"email","id":"em_1"}');
    ac.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
  it("is 403 for sending-only keys", async () => {
    const { secret } = await seedTeamWithKey({ permission: "sending_only" });
    expect(
      (await stream(new Request("http://x/api/v1/stream", auth(secret)), ctx))
        .status,
    ).toBe(403);
  });
});
