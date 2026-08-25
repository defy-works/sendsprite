import { describe, expect, it, vi } from "vitest";
import { Sendsprite } from "../src/index";

function client(status = 200, body: unknown = {}) {
  // `null` → no body (204); `undefined` picks the `{}` default.
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(body === null ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  return {
    c: new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 0,
    }),
    fetch,
  };
}
const call = (fetch: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: init.method,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  };
};

describe("emails", () => {
  it("send → POST /emails, no retry without idempotencyKey", async () => {
    const { c, fetch } = client(201, { id: "em_1" });
    await expect(
      c.emails.send({ from: "a@b.io", to: "c@d.io", subject: "s", text: "t" }),
    ).resolves.toEqual({ id: "em_1" });
    expect(call(fetch)).toMatchObject({
      url: "https://x/api/v1/emails",
      method: "POST",
      body: { to: "c@d.io" },
    });
  });
  it("send without idempotencyKey does not retry a 503", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("{}", { status: 503 }));
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await expect(
      c.emails.send({ from: "a@b.io", to: "c@d.io", subject: "s", text: "t" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("send with idempotencyKey retries a 503", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "em_1" }), { status: 201 }),
      );
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 1,
    });
    vi.useFakeTimers();
    try {
      const p = c.emails.send({
        from: "a@b.io",
        to: "c@d.io",
        subject: "s",
        text: "t",
        idempotencyKey: "i1",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(p).resolves.toEqual({ id: "em_1" });
    } finally {
      vi.useRealTimers();
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("batch → POST /emails/batch", async () => {
    const { c, fetch } = client(201, { data: [{ id: "a" }] });
    await expect(
      c.emails.batch([
        { from: "a@b.io", to: "c@d.io", subject: "s", text: "t" },
      ]),
    ).resolves.toEqual({ data: [{ id: "a" }] });
    expect(call(fetch)).toMatchObject({
      url: "https://x/api/v1/emails/batch",
      method: "POST",
    });
  });
  it("get / list / cancel / reschedule", async () => {
    let r = client();
    await r.c.emails.get("em_1");
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/emails/em_1",
      method: "GET",
    });
    r = client(200, { data: [], nextCursor: null });
    await r.c.emails.list({ status: "sent", limit: 5, cursor: "c" });
    expect(call(r.fetch).url).toBe(
      "https://x/api/v1/emails?limit=5&cursor=c&status=sent",
    );
    r = client();
    await r.c.emails.cancel("em_1");
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/emails/em_1/cancel",
      method: "POST",
    });
    r = client();
    await r.c.emails.reschedule("em_1", {
      scheduledAt: "2030-01-01T00:00:00.000Z",
    });
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/emails/em_1",
      method: "PATCH",
      body: { scheduledAt: "2030-01-01T00:00:00.000Z" },
    });
  });
  it("cancel retries a 503 (safe POST)", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "em_1" }), { status: 200 }),
      );
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 1,
    });
    vi.useFakeTimers();
    try {
      const p = c.emails.cancel("em_1");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(p).resolves.toEqual({ id: "em_1" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("iterate walks every page via nextCursor", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "a" }, { id: "b" }], nextCursor: "n" }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ id: "c" }], nextCursor: null }),
          {
            status: 200,
          },
        ),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const ids: string[] = [];
    for await (const e of c.emails.iterate({ status: "sent", limit: 2 }))
      ids.push(e.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(fetch.mock.calls[0]![0]).toBe(
      "https://x/api/v1/emails?limit=2&status=sent",
    );
    expect(fetch.mock.calls[1]![0]).toBe(
      "https://x/api/v1/emails?limit=2&cursor=n&status=sent",
    );
  });
});

describe("domains / apiKeys / webhooks / suppressions / stats / me", () => {
  it("domains", async () => {
    let r = client(200, { data: [], nextCursor: null });
    await r.c.domains.list();
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/domains",
      method: "GET",
    });
    r = client(200, { data: [], nextCursor: null });
    await r.c.domains.list({ limit: 3, cursor: "z" });
    expect(call(r.fetch).url).toBe("https://x/api/v1/domains?limit=3&cursor=z");
    r = client(201);
    await r.c.domains.create({ name: "mail.x.io" });
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/domains",
      method: "POST",
      body: { name: "mail.x.io" },
    });
    r = client();
    await r.c.domains.get("d1");
    expect(call(r.fetch).url).toBe("https://x/api/v1/domains/d1");
    r = client();
    await r.c.domains.verify("d1");
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/domains/d1/verify",
      method: "POST",
    });
    r = client(204, null);
    await expect(r.c.domains.delete("d1")).resolves.toBeUndefined();
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/domains/d1",
      method: "DELETE",
    });
    r = client(200, { leftoverDnsRecords: 2 });
    await expect(r.c.domains.delete("d1")).resolves.toEqual({
      leftoverDnsRecords: 2,
    });
  });
  it("apiKeys", async () => {
    let r = client(200, { data: [], nextCursor: null });
    await r.c.apiKeys.list();
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/api-keys",
      method: "GET",
    });
    r = client(201, { id: "k", secret: "ss_live_1" });
    await expect(r.c.apiKeys.create({ name: "ci" })).resolves.toEqual({
      id: "k",
      secret: "ss_live_1",
    });
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/api-keys",
      method: "POST",
      body: { name: "ci" },
    });
    r = client(204, null);
    await r.c.apiKeys.revoke("k");
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/api-keys/k",
      method: "DELETE",
    });
  });
  it("webhooks", async () => {
    let r = client(200, { data: [], nextCursor: null });
    await r.c.webhooks.list();
    expect(call(r.fetch).url).toBe("https://x/api/v1/webhooks");
    r = client(201, { id: "w", secret: "whsec_1" });
    await expect(
      r.c.webhooks.create({ url: "https://h.io/x", events: ["email.sent"] }),
    ).resolves.toEqual({ id: "w", secret: "whsec_1" });
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/webhooks",
      method: "POST",
      body: { url: "https://h.io/x", events: ["email.sent"] },
    });
    r = client();
    await r.c.webhooks.update("w", { enabled: false });
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/webhooks/w",
      method: "PATCH",
      body: { enabled: false },
    });
    r = client(202, { deliveryId: "dl" });
    await expect(r.c.webhooks.test("w")).resolves.toEqual({
      deliveryId: "dl",
    });
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/webhooks/w/test",
      method: "POST",
    });
    r = client(204, null);
    await expect(r.c.webhooks.delete("w")).resolves.toBeUndefined();
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/webhooks/w",
      method: "DELETE",
    });
  });
  it("suppressions encode the email path segment", async () => {
    let r = client(200, { data: [], nextCursor: null });
    await r.c.suppressions.list();
    expect(call(r.fetch).url).toBe("https://x/api/v1/suppressions");
    r = client(201);
    await r.c.suppressions.add({ email: "a+tag@b.io" });
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/suppressions",
      method: "POST",
      body: { email: "a+tag@b.io" },
    });
    r = client(204, null);
    await r.c.suppressions.remove("a+tag@b.io");
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/suppressions/a%2Btag%40b.io",
      method: "DELETE",
    });
  });
  it("stats and me", async () => {
    let r = client();
    await r.c.stats();
    expect(call(r.fetch).url).toBe("https://x/api/v1/stats");
    r = client();
    await r.c.me();
    expect(call(r.fetch).url).toBe("https://x/api/v1/me");
  });
  it("request() escape hatch and baseUrl are still exposed", async () => {
    const { c, fetch } = client(200, { ok: true });
    expect(c.baseUrl).toBe("https://x");
    await expect(c.request("GET", "/anything")).resolves.toEqual({ ok: true });
    expect(call(fetch).url).toBe("https://x/api/v1/anything");
  });
});
