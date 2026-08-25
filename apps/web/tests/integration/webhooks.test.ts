import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";
import { webhookDeliveries, webhooks } from "@/db/schema";

// The REST test route and the retry sweep enqueue through pg-boss; stub
// the bridge. `null` from it means "deduped by the exclusive key".
const { bossEnqueue } = vi.hoisted(() => ({
  bossEnqueue: vi.fn(async (): Promise<string | null> => "job"),
}));
vi.mock("@/jobs/enqueue", () => ({ enqueue: bossEnqueue }));

let pg: Awaited<ReturnType<typeof startPg>>;
/** `deliver()` resolves the target before connecting; the fixtures' hosts do not exist. */
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];
let lookup: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  pg = await startPg();
  lookup = vi
    .spyOn(dns.promises, "lookup")
    .mockImplementation(async () => PUBLIC as never);
  process.env.APP_SECRET = "x".repeat(40);
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
});
afterAll(async () => {
  lookup.mockRestore();
  await pg.stop();
});

const actor = {
  userId: "u1",
  teamId: "org_1",
  teamName: "Acme",
  role: "admin" as const,
};
const member = { ...actor, role: "member" as const };

type Call = { url: string; init: RequestInit };
/** A fetch stub answering `status` and recording each call. */
const fetchWith = (status: number) => {
  const calls: Call[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return new Response(status === 204 ? null : "resp", { status });
  };
  return Object.assign(f, { calls });
};
const svc = () => import("@/services/webhooks");
const hook = async (id: string) =>
  (await pg.db.select().from(webhooks).where(eq(webhooks.id, id)))[0]!;
const delivery = async (id: string) =>
  (
    await pg.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id))
  )[0]!;

describe("webhooks", () => {
  it("creates with generated secret (shown once), fans out only subscribed types, delivers with signature headers, records delivery", async () => {
    const { createWebhook, fanOutEvent, deliver } = await svc();
    const w = await createWebhook(actor, {
      url: "https://hooks.acme.com/x",
      events: ["email.delivered"],
    });
    if (!w.ok) throw new Error(w.error);
    expect(w.data.secret).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);
    const row = await hook(w.data.id);
    expect(row.secretEnc).not.toContain(w.data.secret);
    expect(row.secretEnc).toMatch(/^v1\./);
    const enqueue = vi.fn(async () => "");
    const ids = await fanOutEvent(
      "org_1",
      "email.delivered",
      "evt_1",
      { hello: "world" },
      { enqueue, createdAt: new Date("2026-08-25T09:00:00.000Z") },
    );
    expect(ids).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledWith(
      "webhook.deliver",
      { deliveryId: ids[0] },
      { singletonKey: ids[0] },
    );
    expect(
      await fanOutEvent("org_1", "email.bounced", "evt_2", {}, { enqueue }),
    ).toHaveLength(0);
    const f = fetchWith(200);
    expect(await deliver(ids[0]!, { fetch: f, enqueue })).toMatchObject({
      status: "delivered",
      statusCode: 200,
      attempt: 1,
      responseExcerpt: "resp",
    });
    expect(f.calls[0]!.url).toBe("https://hooks.acme.com/x");
    const h = new Headers(f.calls[0]!.init.headers);
    const { verifyWebhookSignature } = await import("@sendsprite/shared");
    expect(
      verifyWebhookSignature(
        String(f.calls[0]!.init.body),
        h.get("sendsprite-signature")!,
        w.data.secret,
      ),
    ).toBe(true);
    expect(h.get("sendsprite-event-id")).toBe("evt_1");
    expect(h.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      id: "evt_1",
      type: "email.delivered",
      createdAt: "2026-08-25T09:00:00.000Z",
      data: { hello: "world" },
    });
    expect(f.calls[0]!.init.redirect).toBe("manual");
    // A delivered row is not sent twice (duplicate job).
    expect(await deliver(ids[0]!, { fetch: f, enqueue })).toMatchObject({
      status: "delivered",
    });
    expect(f.calls).toHaveLength(1);
    // A second hook sees the same event; a disabled one does not.
    const w2 = await createWebhook(actor, {
      url: "https://hooks.acme.com/y",
      events: ["email.delivered", "email.bounced"],
    });
    if (!w2.ok) throw new Error(w2.error);
    expect(
      await fanOutEvent("org_1", "email.bounced", "evt_3", {}, { enqueue }),
    ).toHaveLength(1);
    const { updateWebhook, deleteWebhook } = await svc();
    expect(
      (await updateWebhook(actor, w2.data.id, { enabled: false })).ok,
    ).toBe(true);
    expect(
      await fanOutEvent("org_1", "email.bounced", "evt_4", {}, { enqueue }),
    ).toHaveLength(0);
    expect((await deleteWebhook(actor, w2.data.id)).ok).toBe(true);
    expect((await deleteWebhook(actor, w2.data.id)).ok).toBe(false);
  });

  it("retries on failure with the 1m/5m/30m/2h/8h schedule, marks exhausted, disables after 24h of failures", async () => {
    const {
      createWebhook,
      fanOutEvent,
      deliver,
      updateWebhook,
      RETRY_SCHEDULE_S,
    } = await svc();
    const w = await createWebhook(actor, {
      url: "https://hooks.acme.com/fail",
      events: ["email.bounced"],
    });
    if (!w.ok) throw new Error(w.error);
    const enqueue = vi.fn(async () => "");
    const [id] = await fanOutEvent(
      "org_1",
      "email.bounced",
      "evt_r",
      {},
      { enqueue },
    );
    enqueue.mockClear();
    const { sweepWebhookRetries } =
      await import("@/jobs/handlers/webhook-deliver");
    const t0 = new Date("2026-08-25T10:00:00Z");
    const f = fetchWith(500);
    for (let attempt = 1; attempt <= RETRY_SCHEDULE_S.length; attempt++) {
      const delay = RETRY_SCHEDULE_S[attempt - 1]!;
      const now = new Date(t0.getTime() + attempt * 1000);
      expect(await deliver(id!, { fetch: f, enqueue, now })).toMatchObject({
        status: "pending",
        attempt,
        statusCode: 500,
        nextRetryAt: new Date(now.getTime() + delay * 1000),
      });
      // deliver() never enqueues its own retry (exclusive queue: the key is
      // taken while its job is active); the sweep does, once the row is due.
      expect(enqueue).not.toHaveBeenCalled();
      bossEnqueue.mockClear();
      const due = new Date(now.getTime() + delay * 1000);
      expect(await sweepWebhookRetries(new Date(due.getTime() - 1))).toBe(0);
      expect(bossEnqueue).not.toHaveBeenCalled();
      expect(await sweepWebhookRetries(due)).toBe(1);
      expect(bossEnqueue).toHaveBeenCalledWith(
        "webhook.deliver",
        { deliveryId: id },
        { singletonKey: id },
      );
      // The failure clock starts at the first failure and stays put.
      expect((await hook(w.data.id)).failingSince).toEqual(
        new Date(t0.getTime() + 1000),
      );
    }
    // A sweep whose send is deduped (job still queued/active) counts nothing
    // (a day later the 8 h retry is due, so the send is actually attempted).
    bossEnqueue.mockResolvedValueOnce(null);
    expect(await sweepWebhookRetries(new Date(t0.getTime() + 9e7))).toBe(0);
    // Sixth failure: no delay left → exhausted, nothing left for the sweep.
    expect(
      await deliver(id!, {
        fetch: f,
        enqueue,
        now: new Date(t0.getTime() + 9e5),
      }),
    ).toMatchObject({ status: "exhausted", attempt: 6, nextRetryAt: null });
    expect(await sweepWebhookRetries(new Date(t0.getTime() + 9e6))).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await hook(w.data.id)).enabled).toBe(true);
    // A network error (thrown fetch) counts as a failure with no status code.
    const [id2] = await fanOutEvent(
      "org_1",
      "email.bounced",
      "evt_n",
      {},
      {
        enqueue,
      },
    );
    const boom = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await deliver(id2!, { fetch: boom, enqueue })).toMatchObject({
      status: "pending",
      attempt: 1,
      statusCode: null,
      responseExcerpt: "ECONNREFUSED",
    });
    // Success clears the failure clock.
    expect(
      await deliver(id2!, { fetch: fetchWith(204), enqueue }),
    ).toMatchObject({ status: "delivered", statusCode: 204 });
    expect((await hook(w.data.id)).failingSince).toBeNull();
    // Failing for 24 h disables the webhook and later deliveries are dropped.
    const [id3] = await fanOutEvent(
      "org_1",
      "email.bounced",
      "evt_d",
      {},
      {
        enqueue,
      },
    );
    const since = new Date(t0.getTime() - 25 * 3600 * 1000);
    await pg.db
      .update(webhooks)
      .set({ failingSince: since })
      .where(eq(webhooks.id, w.data.id));
    expect(await deliver(id3!, { fetch: f, enqueue, now: t0 })).toMatchObject({
      status: "pending",
      attempt: 1,
    });
    expect(await hook(w.data.id)).toMatchObject({
      enabled: false,
      failingSince: since,
      disabledReason: "Disabled after 24 hours of failed deliveries.",
    });
    expect(await deliver(id3!, { fetch: f, enqueue, now: t0 })).toBeNull();
    expect(await delivery(id3!)).toMatchObject({
      status: "failed",
      responseExcerpt: "webhook disabled",
    });
    expect(
      await fanOutEvent("org_1", "email.bounced", "evt_x", {}, { enqueue }),
    ).toHaveLength(0);
    // Re-enabling clears the failure state.
    const re = await updateWebhook(actor, w.data.id, { enabled: true });
    expect(re.ok && re.data).toMatchObject({
      enabled: true,
      failingSince: null,
      disabledReason: null,
    });
  });

  it("test delivery endpoint sends a synthetic event; update/delete/list/rotate/replay; members cannot manage", async () => {
    const {
      createWebhook,
      sendTestEvent,
      deliver,
      listDeliveries,
      listWebhooks,
      updateWebhook,
      rotateSecret,
      replayDelivery,
      deleteWebhook,
      getWebhook,
    } = await svc();
    const w = await createWebhook(actor, {
      url: "https://hooks.acme.com/t",
      events: ["email.bounced"], // not subscribed to email.delivered
    });
    if (!w.ok) throw new Error(w.error);
    const enqueue = vi.fn(async () => "");
    const t = await sendTestEvent(actor, w.data.id, { enqueue });
    if (!t.ok) throw new Error(t.error);
    expect(enqueue).toHaveBeenCalledWith(
      "webhook.deliver",
      { deliveryId: t.data.deliveryId },
      { singletonKey: t.data.deliveryId },
    );
    const f = fetchWith(200);
    await deliver(t.data.deliveryId, { fetch: f, enqueue });
    const body = JSON.parse(String(f.calls[0]!.init.body));
    expect(body).toMatchObject({
      type: "email.delivered",
      data: { test: true },
    });
    expect(body.id).toMatch(/^evt_/);
    const list = await listDeliveries("org_1", w.data.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: t.data.deliveryId,
      eventType: "email.delivered",
      status: "delivered",
    });
    // Rotate: the next delivery is signed with the new secret only.
    const r = await rotateSecret(actor, w.data.id);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.secret).toMatch(/^whsec_/);
    expect(r.data.secret).not.toBe(w.data.secret);
    expect(
      (await replayDelivery(actor, t.data.deliveryId, { enqueue })).ok,
    ).toBe(true);
    const [replayed] = await listDeliveries("org_1", w.data.id);
    expect(replayed).toMatchObject({
      attempt: 0,
      status: "pending",
      statusCode: null,
      deliveredAt: null,
    });
    // Due right away, so a deduped enqueue is caught by the next sweep.
    expect(replayed!.nextRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const f2 = fetchWith(200);
    await deliver(t.data.deliveryId, { fetch: f2, enqueue });
    const { verifyWebhookSignature } = await import("@sendsprite/shared");
    const sig = new Headers(f2.calls[0]!.init.headers).get(
      "sendsprite-signature",
    )!;
    const b2 = String(f2.calls[0]!.init.body);
    expect(verifyWebhookSignature(b2, sig, r.data.secret)).toBe(true);
    expect(verifyWebhookSignature(b2, sig, w.data.secret)).toBe(false);
    // Update url + events; list reflects it.
    const u = await updateWebhook(actor, w.data.id, {
      url: "https://hooks.acme.com/t2",
      events: ["email.sent", "email.failed"],
    });
    expect(u.ok && u.data).toMatchObject({
      url: "https://hooks.acme.com/t2",
      events: ["email.sent", "email.failed"],
    });
    expect(
      (await listWebhooks("org_1")).find((x) => x.id === w.data.id)?.url,
    ).toBe("https://hooks.acme.com/t2");
    // Validation: malformed and private targets are refused (create + update).
    expect((await createWebhook(actor, { url: "nope", events: [] })).ok).toBe(
      false,
    );
    for (const bad of [
      "https://localhost/hook",
      "http://127.0.0.1:3000/hook",
      "https://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/",
      "https://[::1]/",
      "https://vault.internal/",
      "ftp://hooks.acme.com/",
    ]) {
      expect(
        await createWebhook(actor, { url: bad, events: ["email.sent"] }),
        bad,
      ).toMatchObject({
        ok: false,
        error: "Webhook URL must be a public https address",
      });
      expect((await updateWebhook(actor, w.data.id, { url: bad })).ok).toBe(
        false,
      );
    }
    expect(
      (
        await createWebhook(actor, {
          url: "https://a.io",
          events: ["email.exploded"],
        })
      ).ok,
    ).toBe(false);
    expect((await updateWebhook(actor, w.data.id, {})).ok).toBe(false);
    expect((await updateWebhook(actor, "wh_nope", { enabled: true })).ok).toBe(
      false,
    );
    // A disabled hook refuses the test event.
    await updateWebhook(actor, w.data.id, { enabled: false });
    expect((await sendTestEvent(actor, w.data.id, { enqueue })).ok).toBe(false);
    // Members cannot manage.
    const denied = { ok: false, code: "forbidden" };
    expect(
      await createWebhook(member, {
        url: "https://a.io",
        events: ["email.sent"],
      }),
    ).toMatchObject(denied);
    expect(
      await updateWebhook(member, w.data.id, { enabled: true }),
    ).toMatchObject(denied);
    expect(await rotateSecret(member, w.data.id)).toMatchObject(denied);
    expect(await sendTestEvent(member, w.data.id, { enqueue })).toMatchObject(
      denied,
    );
    expect(
      await replayDelivery(member, t.data.deliveryId, { enqueue }),
    ).toMatchObject(denied);
    expect(await deleteWebhook(member, w.data.id)).toMatchObject(denied);
    // Team scoping.
    const other = { ...actor, teamId: "org_2" };
    expect(await getWebhook("org_2", w.data.id)).toBeNull();
    expect((await rotateSecret(other, w.data.id)).ok).toBe(false);
    expect(
      (await replayDelivery(other, t.data.deliveryId, { enqueue })).ok,
    ).toBe(false);
    expect((await deleteWebhook(other, w.data.id)).ok).toBe(false);
    expect((await deleteWebhook(actor, w.data.id)).ok).toBe(true);
    expect(await listDeliveries("org_1", w.data.id)).toHaveLength(0); // cascade
  });

  it("a target resolving to a private address is never fetched: the delivery is exhausted at once", async () => {
    const { createWebhook, fanOutEvent, deliver, PRIVATE_TARGET } = await svc();
    const w = await createWebhook(actor, {
      url: "https://rebind.acme.com/x",
      events: ["email.opened"],
    });
    if (!w.ok) throw new Error(w.error);
    const enqueue = vi.fn(async () => "");
    const [id] = await fanOutEvent(
      "org_1",
      "email.opened",
      "evt_p",
      {},
      {
        enqueue,
      },
    );
    // One public answer among private ones is not enough.
    lookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ] as never);
    const f = fetchWith(200);
    const now = new Date("2026-08-25T14:00:00Z");
    expect(await deliver(id!, { fetch: f, enqueue, now })).toMatchObject({
      status: "exhausted",
      attempt: 1,
      statusCode: null,
      responseExcerpt: PRIVATE_TARGET,
      nextRetryAt: null,
    });
    expect(f.calls).toHaveLength(0);
    expect(lookup).toHaveBeenLastCalledWith("rebind.acme.com", { all: true });
    expect((await hook(w.data.id)).failingSince).toEqual(now);
    // A public answer: the request goes out as before.
    const [ok] = await fanOutEvent(
      "org_1",
      "email.opened",
      "evt_q",
      {},
      {
        enqueue,
      },
    );
    expect(await deliver(ok!, { fetch: f, enqueue })).toMatchObject({
      status: "delivered",
    });
    expect(f.calls).toHaveLength(1);
    // A resolver error is an ordinary (retried) failure.
    const [nx] = await fanOutEvent(
      "org_1",
      "email.opened",
      "evt_r",
      {},
      {
        enqueue,
      },
    );
    lookup.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));
    expect(await deliver(nx!, { fetch: f, enqueue })).toMatchObject({
      status: "pending",
      attempt: 1,
      responseExcerpt: "dns: getaddrinfo ENOTFOUND",
    });
    expect(f.calls).toHaveLength(1);
  });

  it("a pending delivery whose first job was lost is due at once and picked up by the sweep", async () => {
    const { createWebhook, fanOutEvent, deliver } = await svc();
    const w = await createWebhook(actor, {
      url: "https://hooks.acme.com/orphan",
      events: ["email.delayed"],
    });
    if (!w.ok) throw new Error(w.error);
    // The enqueue "succeeds" but the job never lands (dropped/expired).
    const [id] = await fanOutEvent(
      "org_1",
      "email.delayed",
      "evt_lost",
      {},
      { enqueue: async () => null },
    );
    const before = await delivery(id!);
    expect(before.status).toBe("pending");
    expect(before.nextRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const { sweepWebhookRetries } =
      await import("@/jobs/handlers/webhook-deliver");
    bossEnqueue.mockClear();
    expect(await sweepWebhookRetries()).toBe(1);
    expect(bossEnqueue).toHaveBeenCalledWith(
      "webhook.deliver",
      { deliveryId: id },
      { singletonKey: id },
    );
    // Once delivered nothing is due any more.
    await deliver(id!, { fetch: fetchWith(200), enqueue: async () => "" });
    expect((await delivery(id!)).nextRetryAt).toBeNull();
    expect(await sweepWebhookRetries()).toBe(0);
  });

  it("does not follow redirects, caps the response read, records timeouts, and marks un-enqueueable deliveries failed", async () => {
    const { createWebhook, fanOutEvent, deliver, EXCERPT_LEN } = await svc();
    const w = await createWebhook(actor, {
      url: "https://hooks.acme.com/h",
      events: ["email.sent"],
    });
    if (!w.ok) throw new Error(w.error);
    const enqueue = vi.fn(async () => "");
    const fan = () =>
      fanOutEvent("org_1", "email.sent", "evt_h", {}, { enqueue });
    // 3xx: a failed attempt with the code kept and no body read.
    const [r] = await fan();
    const redirect = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.example/" },
      });
    expect(await deliver(r!, { fetch: redirect, enqueue })).toMatchObject({
      status: "pending",
      attempt: 1,
      statusCode: 302,
      responseExcerpt: "redirect not followed",
    });
    // Large body: only EXCERPT_LEN bytes are read, then the stream is cancelled.
    const [big] = await fan();
    let pulls = 0;
    let cancelled = false;
    const chunk = new TextEncoder().encode("x".repeat(100));
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const huge = async () => new Response(endless, { status: 200 });
    const res = await deliver(big!, { fetch: huge, enqueue });
    expect(res).toMatchObject({ status: "delivered", statusCode: 200 });
    expect(res!.responseExcerpt).toHaveLength(EXCERPT_LEN);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20);
    // A plain large body is truncated too.
    const [big2] = await fan();
    const plain = async () => new Response("y".repeat(10_000), { status: 200 });
    expect(
      (await deliver(big2!, { fetch: plain, enqueue }))!.responseExcerpt,
    ).toBe("y".repeat(EXCERPT_LEN));
    // Timeout (AbortSignal.timeout rejects with a TimeoutError DOMException).
    const [slow] = await fan();
    const timeout = async () => {
      throw new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
    };
    const now = new Date("2026-08-25T12:00:00Z");
    const sends = enqueue.mock.calls.length; // fan-out sent it once already
    expect(
      await deliver(slow!, { fetch: timeout, enqueue, now }),
    ).toMatchObject({
      status: "pending",
      attempt: 1,
      statusCode: null,
      responseExcerpt: "The operation was aborted due to timeout",
      nextRetryAt: new Date(now.getTime() + 60_000),
    });
    // The retry is left to the sweep; deliver() itself sends nothing.
    expect(enqueue.mock.calls).toHaveLength(sends);
    // Enqueue failure: the row is marked failed instead of lingering pending.
    const broken = vi.fn(async () => {
      throw new Error("pg-boss down");
    });
    const [orphan] = await fanOutEvent(
      "org_1",
      "email.sent",
      "evt_o",
      {},
      {
        enqueue: broken,
      },
    );
    expect(await delivery(orphan!)).toMatchObject({
      status: "failed",
      responseExcerpt: "could not enqueue",
    });
  });

  it("REST: 401/403, create returns the secret once, list, patch, test, delete", async () => {
    const { createApiKey } = await import("@/services/api-keys");
    const k = await createApiKey(actor, { name: "root" });
    const s = await createApiKey(actor, {
      name: "send",
      permission: "sending_only",
    });
    if (!k.ok || !s.ok) throw new Error("seed failed");
    const req = (method: string, key?: string, body?: unknown) =>
      new Request("http://localhost/api/v1/webhooks", {
        method,
        headers: {
          ...(key && { authorization: `Bearer ${key}` }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const noParams = { params: Promise.resolve({}) };
    const { GET, POST } = await import("@/app/api/v1/webhooks/route");
    expect((await GET(req("GET"), noParams)).status).toBe(401);
    expect((await GET(req("GET", s.data.secret), noParams)).status).toBe(403);
    const created = await POST(
      req("POST", k.data.secret, {
        url: "https://hooks.acme.com/rest",
        events: ["email.delivered"],
      }),
      noParams,
    );
    expect(created.status).toBe(201);
    const { id, secret } = await created.json();
    expect(secret).toMatch(/^whsec_/);
    const bad = await POST(req("POST", k.data.secret, { url: "x" }), noParams);
    expect(bad.status).toBe(400);
    const list = await (await GET(req("GET", k.data.secret), noParams)).json();
    expect(list.data.find((w: { id: string }) => w.id === id)).toMatchObject({
      url: "https://hooks.acme.com/rest",
      enabled: true,
    });
    expect(JSON.stringify(list)).not.toContain("secret");
    const params = { params: Promise.resolve({ id }) };
    const { PATCH, DELETE } = await import("@/app/api/v1/webhooks/[id]/route");
    const patched = await PATCH(
      req("PATCH", k.data.secret, { events: ["email.bounced"] }),
      params,
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      id,
      events: ["email.bounced"],
    });
    expect(
      (
        await PATCH(req("PATCH", k.data.secret, { enabled: false }), {
          params: Promise.resolve({ id: "wh_nope" }),
        })
      ).status,
    ).toBe(404);
    const { POST: TEST } =
      await import("@/app/api/v1/webhooks/[id]/test/route");
    const tested = await TEST(req("POST", k.data.secret), params);
    expect(tested.status).toBe(202);
    expect((await tested.json()).deliveryId).toMatch(/^whd_/);
    expect((await DELETE(req("DELETE", k.data.secret), params)).status).toBe(
      204,
    );
    expect((await DELETE(req("DELETE", k.data.secret), params)).status).toBe(
      404,
    );
  });
});
