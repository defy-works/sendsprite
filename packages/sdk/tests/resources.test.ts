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

/**
 * Multi-call variant of `client()`: one stub `fetch` that answers call `n`
 * from `respond(n)` and records the method, the path relative to `/api/v1`
 * and the parsed body of every call. `client()` above only keeps the first.
 */
function recorder(
  respond: (n: number) => { status?: number; body?: unknown } = () => ({}),
  maxRetries = 0,
) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let n = 0;
  // `mockImplementation` rather than an implementation argument: `typeof
  // fetch` carries a `preconnect` static that a plain function lacks.
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (url, init) => {
      const i = (init ?? {}) as RequestInit;
      calls.push({
        method: i.method ?? "GET",
        path: String(url).replace("https://x/api/v1", ""),
        body: i.body === undefined ? undefined : JSON.parse(i.body as string),
      });
      const { status = 200, body = {} } = respond(n++);
      return new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    });
  return {
    ss: new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries,
    }),
    calls,
    fetch,
  };
}

describe("templates", () => {
  it("lists, gets, creates, updates, deletes and renders", async () => {
    const { ss, calls } = recorder();
    await ss.templates.list({ limit: 10 });
    await ss.templates.get("welcome");
    await ss.templates.create({
      slug: "welcome",
      name: "Welcome",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
    });
    await ss.templates.update("welcome", { name: "W" });
    await ss.templates.remove("welcome");
    await ss.templates.render("welcome", { name: "Mingu" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /templates?limit=10",
      "GET /templates/welcome",
      "POST /templates",
      "PATCH /templates/welcome",
      "DELETE /templates/welcome",
      "POST /templates/welcome/render",
    ]);
    expect(calls[5]!.body).toEqual({ variables: { name: "Mingu" } });
  });

  it("renders with no variables at all", async () => {
    const { ss, calls } = recorder();
    await ss.templates.render("welcome");
    expect(calls[0]!.body).toEqual({ variables: {} });
  });

  it("URL-encodes a slug", async () => {
    const { ss, calls } = recorder();
    await ss.templates.get("a/b");
    expect(calls[0]!.path).toBe("/templates/a%2Fb");
  });

  it("iterates every page of templates", async () => {
    const { ss } = recorder((n) =>
      n === 0
        ? { body: { data: [{ id: "tpl_1" }], nextCursor: "c" } }
        : { body: { data: [{ id: "tpl_2" }], nextCursor: null } },
    );
    const seen: string[] = [];
    for await (const t of ss.templates.iterate()) seen.push(t.id);
    expect(seen).toEqual(["tpl_1", "tpl_2"]);
  });

  it("retries render (a read in POST's clothing) but not create", async () => {
    const retried = recorder(
      (n) => (n === 0 ? { status: 503 } : { body: { subject: "s" } }),
      1,
    );
    vi.useFakeTimers();
    try {
      const p = retried.ss.templates.render("welcome");
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(p).resolves.toMatchObject({ subject: "s" });
    } finally {
      vi.useRealTimers();
    }
    expect(retried.fetch).toHaveBeenCalledTimes(2);

    const once = recorder(() => ({ status: 503 }), 1);
    await expect(
      once.ss.templates.create({
        slug: "welcome",
        name: "Welcome",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(once.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("contactBooks and contacts", () => {
  it("walks the nested paths", async () => {
    const { ss, calls } = recorder();
    await ss.contactBooks.list();
    await ss.contactBooks.create({ name: "News" });
    await ss.contactBooks.get("cb_1");
    await ss.contactBooks.update("cb_1", { name: "N" });
    await ss.contactBooks.remove("cb_1");
    await ss.contactBooks.import("cb_1", { csv: "email\na@b.io" });
    await ss.contacts.list("cb_1", { q: "ada" });
    await ss.contacts.create("cb_1", { email: "a@b.io" });
    await ss.contacts.get("cb_1", "ct_1");
    await ss.contacts.update("cb_1", "ct_1", { subscribed: false });
    await ss.contacts.remove("cb_1", "ct_1");
    await ss.contacts.unsubscribe({ email: "a@b.io" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /contact-books",
      "POST /contact-books",
      "GET /contact-books/cb_1",
      "PATCH /contact-books/cb_1",
      "DELETE /contact-books/cb_1",
      "POST /contact-books/cb_1/contacts/import",
      "GET /contact-books/cb_1/contacts?q=ada",
      "POST /contact-books/cb_1/contacts",
      "GET /contact-books/cb_1/contacts/ct_1",
      "PATCH /contact-books/cb_1/contacts/ct_1",
      "DELETE /contact-books/cb_1/contacts/ct_1",
      "POST /contacts/unsubscribe",
    ]);
  });

  it("sends the subscribed filter as a string, and omits it when unset", async () => {
    const { ss, calls } = recorder();
    await ss.contacts.list("cb_1", { subscribed: false, limit: 5 });
    await ss.contacts.list("cb_1");
    expect(calls[0]!.path).toBe(
      "/contact-books/cb_1/contacts?limit=5&subscribed=false",
    );
    expect(calls[1]!.path).toBe("/contact-books/cb_1/contacts");
  });

  it("iterates every page of contacts", async () => {
    const { ss } = recorder((n) =>
      n === 0
        ? { body: { data: [{ id: "ct_1" }], nextCursor: "c" } }
        : { body: { data: [{ id: "ct_2" }], nextCursor: null } },
    );
    const seen: string[] = [];
    for await (const c of ss.contacts.iterate("cb_1")) seen.push(c.id);
    expect(seen).toEqual(["ct_1", "ct_2"]);
  });

  it("returns the import report rather than throwing on partial failure", async () => {
    const report = {
      imported: 2,
      updated: 1,
      skipped: 1,
      duplicates: 0,
      errors: [{ line: 4, email: null, reason: "Ragged row." }],
    };
    const { ss } = recorder(() => ({ body: report }));
    await expect(
      ss.contactBooks.import("cb_1", { csv: "email\na@b.io" }),
    ).resolves.toEqual(report);
  });

  it("does not retry an import, but does retry an unsubscribe", async () => {
    const imports = recorder(() => ({ status: 503 }), 1);
    await expect(
      imports.ss.contactBooks.import("cb_1", { csv: "email\na@b.io" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(imports.fetch).toHaveBeenCalledTimes(1);

    const unsub = recorder(
      (n) => (n === 0 ? { status: 503 } : { body: { unsubscribed: 1 } }),
      1,
    );
    vi.useFakeTimers();
    try {
      const p = unsub.ss.contacts.unsubscribe({ email: "a@b.io" });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(p).resolves.toEqual({ unsubscribed: 1 });
    } finally {
      vi.useRealTimers();
    }
    expect(unsub.fetch).toHaveBeenCalledTimes(2);
  });
});
