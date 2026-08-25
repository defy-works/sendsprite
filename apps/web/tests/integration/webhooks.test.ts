import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";
import { webhookDeliveries, webhooks } from "@/db/schema";

// The REST test route enqueues through pg-boss; stub the bridge.
vi.mock("@/jobs/enqueue", () => ({ enqueue: vi.fn(async () => "") }));

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
});
afterAll(async () => {
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
      { enqueue },
    );
    expect(ids).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledWith("webhook.deliver", {
      deliveryId: ids[0],
    });
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
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({
      id: "evt_1",
      type: "email.delivered",
      data: { hello: "world" },
    });
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
      expect(enqueue).toHaveBeenLastCalledWith(
        "webhook.deliver",
        { deliveryId: id },
        { startAfter: delay },
      );
      // The failure clock starts at the first failure and stays put.
      expect((await hook(w.data.id)).failingSince).toEqual(
        new Date(t0.getTime() + 1000),
      );
    }
    expect(enqueue).toHaveBeenCalledTimes(RETRY_SCHEDULE_S.length);
    // Sixth failure: no delay left → exhausted, nothing enqueued.
    expect(
      await deliver(id!, {
        fetch: f,
        enqueue,
        now: new Date(t0.getTime() + 9e5),
      }),
    ).toMatchObject({ status: "exhausted", attempt: 6, nextRetryAt: null });
    expect(enqueue).toHaveBeenCalledTimes(RETRY_SCHEDULE_S.length);
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
    expect(enqueue).toHaveBeenCalledWith("webhook.deliver", {
      deliveryId: t.data.deliveryId,
    });
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
    expect(await listDeliveries("org_1", w.data.id)).toMatchObject([
      { attempt: 0, status: "pending", statusCode: null, deliveredAt: null },
    ]);
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
    // Validation.
    expect((await createWebhook(actor, { url: "nope", events: [] })).ok).toBe(
      false,
    );
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
