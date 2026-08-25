import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPg } from "./_pg";

// The routes enqueue `email.send` (and domain jobs) through pg-boss. A module
// mock of the bridge is simpler than booting pg-boss send-only for a test
// that only cares about the HTTP contract; the send path is covered by
// email-send.test.ts. SES is never called at create time (the job does).
vi.mock("@/jobs/enqueue", () => ({ enqueue: vi.fn(async () => "job") }));

let pg: Awaited<ReturnType<typeof startPg>>;
let full: string;
let sendingOnly: string;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "https://mail.acme.com";
  (await import("@/env.schema")).resetEnvCache();
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
  const { domains, teamSettings } = await import("@/db/schema");
  await pg.db.insert(domains).values({
    id: "dom_1",
    teamId: "org_1",
    name: "mail.acme.com",
    region: "eu-west-1",
    dnsMode: "auto",
    mailFromDomain: "bounce.mail.acme.com",
    status: "verified",
    verifiedAt: new Date(),
    expectedRecords: [
      {
        kind: "DKIM",
        type: "CNAME",
        name: "a._domainkey.mail.acme.com",
        value: "a.dkim.amazonses.com",
        cloudflareId: "cf_1",
        ok: true,
      },
      {
        kind: "MAIL_FROM_MX",
        type: "MX",
        name: "bounce.mail.acme.com",
        value: "feedback-smtp.eu-west-1.amazonses.com",
        priority: 10,
        cloudflareId: "cf_2",
        ok: false,
      },
    ],
  });
  await pg.db.insert(teamSettings).values({ teamId: "org_1", dailyLimit: 100 });
  const { createApiKey } = await import("@/services/api-keys");
  const actor = {
    userId: "u1",
    teamId: "org_1",
    teamName: "Acme",
    role: "owner" as const,
  };
  const a = await createApiKey(actor, { name: "root" });
  const b = await createApiKey(actor, {
    name: "send",
    permission: "sending_only",
  });
  if (!a.ok || !b.ok) throw new Error("seed failed");
  full = a.data.secret;
  sendingOnly = b.data.secret;
});
afterAll(async () => {
  await pg.stop();
});

const BASE = "http://localhost/api/v1";
const req = (
  path: string,
  o: {
    method?: string;
    body?: unknown;
    auth?: string;
    headers?: Record<string, string>;
  } = {},
) =>
  new Request(`${BASE}${path}`, {
    method: o.method ?? "GET",
    headers: {
      authorization: o.auth ?? `Bearer ${full}`,
      ...(o.body !== undefined && { "content-type": "application/json" }),
      ...o.headers,
    },
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
  });
const noParams = { params: Promise.resolve({}) };
const withId = (id: string) => ({ params: Promise.resolve({ id }) });
const mail = { from: "a@mail.acme.com", to: "r@x.io", subject: "s", text: "t" };
const json = <T = Record<string, unknown>>(r: Response) =>
  r.json() as Promise<T>;

describe("REST /api/v1/emails", () => {
  it("POST → 201 {id} with rate headers; envelope on refusals; 401 without a key", async () => {
    const { POST } = await import("@/app/api/v1/emails/route");
    const post = await POST(
      req("/emails", { method: "POST", body: mail }),
      noParams,
    );
    expect(post.status).toBe(201);
    const { id } = await json<{ id: string }>(post);
    expect(id).toMatch(/^em_/);
    expect(post.headers.get("x-ratelimit-limit")).toBe("100");
    expect(post.headers.get("x-ratelimit-remaining")).toBe("99");
    const reset = Number(post.headers.get("x-ratelimit-reset"));
    expect(reset * 1000).toBeGreaterThan(Date.now());
    expect(reset % 86400).toBe(0);

    const bad = await POST(
      req("/emails", { method: "POST", body: { ...mail, from: "a@nope.io" } }),
      noParams,
    );
    expect(bad.status).toBe(422);
    expect(await json(bad)).toMatchObject({
      error: { code: "domain_not_verified" },
    });
    expect(bad.headers.get("x-ratelimit-limit")).toBe("100");
    const invalid = await POST(
      req("/emails", { method: "POST", body: { from: "a@mail.acme.com" } }),
      noParams,
    );
    expect(invalid.status).toBe(400);
    expect(await json(invalid)).toMatchObject({
      error: { code: "validation_error" },
    });
    const notJson = await POST(
      new Request(`${BASE}/emails`, {
        method: "POST",
        headers: { authorization: `Bearer ${full}` },
        body: "{nope",
      }),
      noParams,
    );
    expect(notJson.status).toBe(400);
    expect(
      (
        await POST(
          req("/emails", { method: "POST", body: {}, auth: "Bearer nope" }),
          noParams,
        )
      ).status,
    ).toBe(401);
    // Over the body cap: refused before parsing.
    const huge = await POST(
      req("/emails", {
        method: "POST",
        body: mail,
        headers: { "content-length": String(30 * 1024 * 1024) },
      }),
      noParams,
    );
    expect(huge.status).toBe(413);
    expect(await json(huge)).toMatchObject({
      error: { code: "payload_too_large" },
    });
    // A sending-only key can send…
    const so = await POST(
      req("/emails", {
        method: "POST",
        body: mail,
        auth: `Bearer ${sendingOnly}`,
      }),
      noParams,
    );
    expect(so.status).toBe(201);
  });

  it("batch → 201 {data:[{id}]}, or the envelope with details.index", async () => {
    const { POST } = await import("@/app/api/v1/emails/batch/route");
    const okRes = await POST(
      req("/emails/batch", { method: "POST", body: [mail, mail] }),
      noParams,
    );
    expect(okRes.status).toBe(201);
    const { data } = await json<{ data: { id: string }[] }>(okRes);
    expect(data).toHaveLength(2);
    expect(data.every((d) => d.id.startsWith("em_"))).toBe(true);
    const bad = await POST(
      req("/emails/batch", {
        method: "POST",
        body: [mail, { ...mail, from: "a@nope.io" }],
      }),
      noParams,
    );
    expect(bad.status).toBe(422);
    expect(await json(bad)).toMatchObject({
      error: { code: "domain_not_verified", details: { index: 1 } },
    });
    const invalid = await POST(
      req("/emails/batch", { method: "POST", body: { nope: 1 } }),
      noParams,
    );
    expect(invalid.status).toBe(400);
    expect(
      (
        await POST(
          req("/emails/batch", {
            method: "POST",
            body: [mail],
            auth: `Bearer ${sendingOnly}`,
          }),
          noParams,
        )
      ).status,
    ).toBe(201);
  });

  it("GET /:id returns the public shape + events; list paginates; sending-only → 403", async () => {
    const { GET: list } = await import("@/app/api/v1/emails/route");
    const { GET: get } = await import("@/app/api/v1/emails/[id]/route");
    const page1 = await list(req("/emails?limit=2"), noParams);
    expect(page1.status).toBe(200);
    const p1 = await json<{
      data: Record<string, unknown>[];
      nextCursor: string | null;
    }>(page1);
    expect(p1.data).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    expect(Object.keys(p1.data[0]!).sort()).toEqual([
      "bcc",
      "cc",
      "createdAt",
      "from",
      "id",
      "lastError",
      "replyTo",
      "scheduledAt",
      "sentAt",
      "status",
      "subject",
      "tags",
      "to",
    ]);
    const page2 = await list(
      req(`/emails?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`),
      noParams,
    );
    const p2 = await json<typeof p1>(page2);
    expect(p2.data.map((e) => e.id)).not.toContain(p1.data[0]!.id);
    expect((await list(req("/emails?limit=0"), noParams)).status).toBe(400);
    expect(
      (await list(req("/emails?status=cancelled"), noParams).then(json)).data,
    ).toEqual([]);

    const id = p1.data[0]!.id as string;
    const one = await get(req(`/emails/${id}`), withId(id));
    expect(one.status).toBe(200);
    const body = await json<{ events: Record<string, unknown>[] }>(one);
    expect(body).toMatchObject({ id, status: "queued" });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ type: "queued" });
    expect(Object.keys(body.events[0]!).sort()).toEqual([
      "id",
      "occurredAt",
      "payload",
      "type",
    ]);
    expect(JSON.stringify(body)).not.toContain('"html"');
    expect((await get(req("/emails/em_nope"), withId("em_nope"))).status).toBe(
      404,
    );
    const so = await get(
      req(`/emails/${id}`, { auth: `Bearer ${sendingOnly}` }),
      withId(id),
    );
    expect(so.status).toBe(403);
    expect(
      (await list(req("/emails", { auth: `Bearer ${sendingOnly}` }), noParams))
        .status,
    ).toBe(403);
  });

  it("PATCH reschedules only scheduled emails; cancel flips queued/scheduled", async () => {
    const { POST: create } = await import("@/app/api/v1/emails/route");
    const { PATCH } = await import("@/app/api/v1/emails/[id]/route");
    const { POST: cancel } =
      await import("@/app/api/v1/emails/[id]/cancel/route");
    const queued = await create(
      req("/emails", { method: "POST", body: mail }),
      noParams,
    ).then(json<{ id: string }>);
    const later = new Date(Date.now() + 3600_000).toISOString();
    const scheduled = await create(
      req("/emails", { method: "POST", body: { ...mail, scheduledAt: later } }),
      noParams,
    ).then(json<{ id: string }>);

    const conflict = await PATCH(
      req(`/emails/${queued.id}`, {
        method: "PATCH",
        body: { scheduledAt: later },
      }),
      withId(queued.id),
    );
    expect(conflict.status).toBe(409);
    expect(await json(conflict)).toMatchObject({ error: { code: "conflict" } });
    const noBody = await PATCH(
      req(`/emails/${scheduled.id}`, { method: "PATCH", body: {} }),
      withId(scheduled.id),
    );
    expect(noBody.status).toBe(400);
    const past = await PATCH(
      req(`/emails/${scheduled.id}`, {
        method: "PATCH",
        body: { scheduledAt: "2000-01-01T00:00:00Z" },
      }),
      withId(scheduled.id),
    );
    expect(past.status).toBe(400);
    const moved = new Date(Date.now() + 7200_000).toISOString();
    const okRes = await PATCH(
      req(`/emails/${scheduled.id}`, {
        method: "PATCH",
        body: { scheduledAt: moved },
      }),
      withId(scheduled.id),
    );
    expect(okRes.status).toBe(200);
    expect(await json(okRes)).toMatchObject({
      id: scheduled.id,
      status: "scheduled",
      scheduledAt: moved,
    });

    const c = await cancel(
      req(`/emails/${queued.id}/cancel`, { method: "POST" }),
      withId(queued.id),
    );
    expect(c.status).toBe(200);
    expect(await json(c)).toMatchObject({ id: queued.id, status: "cancelled" });
    const again = await cancel(
      req(`/emails/${queued.id}/cancel`, { method: "POST" }),
      withId(queued.id),
    );
    expect(again.status).toBe(409);
    expect(
      (
        await cancel(
          req("/emails/em_nope/cancel", { method: "POST" }),
          withId("em_nope"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await cancel(
          req(`/emails/${scheduled.id}/cancel`, {
            method: "POST",
            auth: `Bearer ${sendingOnly}`,
          }),
          withId(scheduled.id),
        )
      ).status,
    ).toBe(403);
  });
});

describe("REST /api/v1/domains", () => {
  it("lists and gets the public shape (no cloudflareId); 403 for sending-only; 404 unknown", async () => {
    const { GET: list, POST } = await import("@/app/api/v1/domains/route");
    const { GET: get, DELETE } =
      await import("@/app/api/v1/domains/[id]/route");
    const { POST: verify } =
      await import("@/app/api/v1/domains/[id]/verify/route");
    const l = await list(req("/domains"), noParams);
    expect(l.status).toBe(200);
    const { data } = await json<{ data: Record<string, unknown>[] }>(l);
    expect(data).toHaveLength(1);
    expect(Object.keys(data[0]!).sort()).toEqual([
      "createdAt",
      "dnsMode",
      "id",
      "lastError",
      "name",
      "records",
      "region",
      "status",
      "verifiedAt",
    ]);
    expect(data[0]!.records).toEqual([
      {
        kind: "DKIM",
        type: "CNAME",
        name: "a._domainkey.mail.acme.com",
        value: "a.dkim.amazonses.com",
        priority: null,
        ok: true,
      },
      {
        kind: "MAIL_FROM_MX",
        type: "MX",
        name: "bounce.mail.acme.com",
        value: "feedback-smtp.eu-west-1.amazonses.com",
        priority: 10,
        ok: false,
      },
    ]);
    expect(JSON.stringify(data)).not.toContain("cf_1");
    const one = await get(req("/domains/dom_1"), withId("dom_1"));
    expect(one.status).toBe(200);
    expect(await json(one)).toMatchObject({ id: "dom_1", status: "verified" });
    expect((await get(req("/domains/dom_x"), withId("dom_x"))).status).toBe(
      404,
    );
    for (const r of [
      list(req("/domains", { auth: `Bearer ${sendingOnly}` }), noParams),
      get(
        req("/domains/dom_1", { auth: `Bearer ${sendingOnly}` }),
        withId("dom_1"),
      ),
      POST(
        req("/domains", {
          method: "POST",
          body: { name: "x.io" },
          auth: `Bearer ${sendingOnly}`,
        }),
        noParams,
      ),
      DELETE(
        req("/domains/dom_1", {
          method: "DELETE",
          auth: `Bearer ${sendingOnly}`,
        }),
        withId("dom_1"),
      ),
      verify(
        req("/domains/dom_1/verify", {
          method: "POST",
          auth: `Bearer ${sendingOnly}`,
        }),
        withId("dom_1"),
      ),
    ])
      expect((await r).status).toBe(403);
  });

  it("POST validates; verify/delete map service refusals; delete removes", async () => {
    const { POST } = await import("@/app/api/v1/domains/route");
    const { GET: get, DELETE } =
      await import("@/app/api/v1/domains/[id]/route");
    const { POST: verify } =
      await import("@/app/api/v1/domains/[id]/verify/route");
    const bad = await POST(
      req("/domains", { method: "POST", body: { name: "not a domain" } }),
      noParams,
    );
    expect(bad.status).toBe(400);
    expect(await json(bad)).toMatchObject({
      error: { code: "validation_error" },
    });
    // AWS is not connected on this instance: a valid name is refused too.
    const noAws = await POST(
      req("/domains", { method: "POST", body: { name: "x.io" } }),
      noParams,
    );
    expect(noAws.status).toBe(400);
    // Never provisioned (no DKIM tokens): verify is refused, domain untouched.
    const v = await verify(
      req("/domains/dom_1/verify", { method: "POST" }),
      withId("dom_1"),
    );
    expect(v.status).toBe(400);
    expect(
      (
        await verify(
          req("/domains/dom_x/verify", { method: "POST" }),
          withId("dom_x"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await DELETE(
          req("/domains/dom_x", { method: "DELETE" }),
          withId("dom_x"),
        )
      ).status,
    ).toBe(404);
    const del = await DELETE(
      req("/domains/dom_1", { method: "DELETE" }),
      withId("dom_1"),
    );
    expect(del.status).toBe(204);
    expect((await get(req("/domains/dom_1"), withId("dom_1"))).status).toBe(
      404,
    );
  });
});
