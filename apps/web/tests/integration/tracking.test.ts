import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";
import { emailEvents, emails } from "@/db/schema";

// Webhook fan-out enqueues through pg-boss; stub the bridge.
vi.mock("@/jobs/enqueue", () => ({ enqueue: vi.fn(async () => "") }));

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  (await import("@/env.schema")).resetEnvCache();
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
  const base = {
    teamId: "org_1",
    from: "a@mail.acme.com",
    fromEmail: "a@mail.acme.com",
    to: ["r@x.io"],
    subject: "s",
    status: "sent" as const,
  };
  await pg.db.insert(emails).values([
    { ...base, id: "em_1" },
    { ...base, id: "em_off", trackOpens: false, trackClicks: false },
  ]);
});
afterAll(async () => {
  await pg.stop();
});

const events = (emailId: string) =>
  pg.db.select().from(emailEvents).where(eq(emailEvents.emailId, emailId));
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("tracking", () => {
  it("open pixel records opened once per (email, ua, day) and returns a gif", async () => {
    const { GET } = await import("@/app/t/o/[id]/route");
    const open = (id: string, ua = "ua") =>
      GET(
        new Request(`https://mail.acme.com/t/o/${id}`, {
          headers: { "user-agent": ua, "x-real-ip": "203.0.113.9" },
        }),
        ctx(id),
      );
    const res = await open("em_1.gif");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(new Uint8Array(await res.arrayBuffer())[0]).toBe(0x47); // "G"
    let rows = await events("em_1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "opened",
      payload: { ip: "203.0.113.9", userAgent: "ua" },
    });
    expect(rows[0]!.dedupeKey).toMatch(/^open:[0-9a-f]{12}:\d{4}-\d{2}-\d{2}$/);
    // Same day + UA: no new event. Another UA: a second one.
    expect((await open("em_1.gif")).status).toBe(200);
    expect(await events("em_1")).toHaveLength(1);
    await open("em_1.gif", "other");
    rows = await events("em_1");
    expect(rows).toHaveLength(2);
    // Unknown id, no `.gif`, and tracking off: still the gif, nothing recorded.
    expect((await open("em_nope.gif")).status).toBe(200);
    expect((await open("em_1")).status).toBe(200);
    expect(await events("em_1")).toHaveLength(2);
    expect((await open("em_off.gif")).status).toBe(200);
    expect(await events("em_off")).toHaveLength(0);
  });

  it("click redirects only with a valid signature and records clicked", async () => {
    const { signClick } = await import("@/lib/tracking");
    const env = (await import("@/env.schema")).loadEnv();
    const { GET } = await import("@/app/t/c/[id]/route");
    const click = (id: string, u: string, s: string, ua = "ua") =>
      GET(
        new Request(
          `https://mail.acme.com/t/c/${id}?u=${encodeURIComponent(u)}&s=${s}`,
          { headers: { "user-agent": ua } },
        ),
        ctx(id),
      );
    const s = signClick("em_1", "https://x.io/a", env.APP_SECRET);
    const ok = await click("em_1", "https://x.io/a", s);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("https://x.io/a");
    expect(ok.headers.get("cache-control")).toMatch(/no-store/);
    let rows = (await events("em_1")).filter((r) => r.type === "clicked");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      payload: { url: "https://x.io/a", ip: null, userAgent: "ua" },
    });
    expect(rows[0]!.dedupeKey).toMatch(
      /^click:[0-9a-f]{16}:\d{4}-\d{2}-\d{2}$/,
    );
    // Same url + UA + day dedupes.
    await click("em_1", "https://x.io/a", s);
    rows = (await events("em_1")).filter((r) => r.type === "clicked");
    expect(rows).toHaveLength(1);

    // Signature for another url, another email id, or missing → 400.
    const bad = await click("em_1", "https://evil.io", s);
    expect(bad.status).toBe(400);
    expect(bad.headers.get("location")).toBeNull();
    expect((await click("em_off", "https://x.io/a", s)).status).toBe(400);
    expect((await click("em_1", "https://x.io/a", "")).status).toBe(400);
    // Non-http(s) targets never redirect even when signed.
    const js = "javascript:alert(1)";
    expect(
      (await click("em_1", js, signClick("em_1", js, env.APP_SECRET))).status,
    ).toBe(400);
    // Tracking off: redirect, but nothing recorded. Unknown id: same.
    const off = await click(
      "em_off",
      "https://x.io/b",
      signClick("em_off", "https://x.io/b", env.APP_SECRET),
    );
    expect(off.status).toBe(302);
    expect(await events("em_off")).toHaveLength(0);
    const gone = await click(
      "em_nope",
      "https://x.io/b",
      signClick("em_nope", "https://x.io/b", env.APP_SECRET),
    );
    expect(gone.status).toBe(302);
  });
});
