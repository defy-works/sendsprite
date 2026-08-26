import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_VARIABLE_VALUE_CHARS } from "@sendsprite/shared";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
let secret: string;
let sendingOnly: string;
beforeAll(async () => {
  pg = await startPg();
  secret = (await seedTeamWithKey()).secret;
  sendingOnly = (await seedTeamWithKey({ permission: "sending_only" })).secret;
});
afterAll(async () => {
  await pg.stop();
});

const BASE = "http://localhost/api/v1/templates";
const req = (method: string, url = BASE, key?: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const noParams = { params: Promise.resolve({}) };
const withSlug = (slug: string) => ({ params: Promise.resolve({ slug }) });

const draft = {
  slug: "welcome",
  name: "Welcome",
  subject: "Hi {{name}}",
  bodyHtml: "<p>Hello {{name}}</p>",
};

describe("REST /api/v1/templates", () => {
  it("401 without a key, 403 for a sending-only key on every route", async () => {
    const list = await import("@/app/api/v1/templates/route");
    const one = await import("@/app/api/v1/templates/[slug]/route");
    const render = await import("@/app/api/v1/templates/[slug]/render/route");
    expect((await list.GET(req("GET"), noParams)).status).toBe(401);
    for (const res of [
      await list.GET(req("GET", BASE, sendingOnly), noParams),
      await list.POST(req("POST", BASE, sendingOnly, draft), noParams),
      await one.GET(req("GET", BASE, sendingOnly), withSlug("welcome")),
      await one.PATCH(
        req("PATCH", BASE, sendingOnly, { name: "x" }),
        withSlug("welcome"),
      ),
      await one.DELETE(req("DELETE", BASE, sendingOnly), withSlug("welcome")),
      await render.POST(
        req("POST", BASE, sendingOnly, {}),
        withSlug("welcome"),
      ),
    ])
      expect(res.status).toBe(403);
  });

  it("creates (201), lists, reads with its version history, patches and deletes (204)", async () => {
    const list = await import("@/app/api/v1/templates/route");
    const one = await import("@/app/api/v1/templates/[slug]/route");
    const created = await list.POST(req("POST", BASE, secret, draft), noParams);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ slug: "welcome", version: 1 });

    const page = await list.GET(req("GET", BASE, secret), noParams);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ nextCursor: null });

    await one.PATCH(
      req("PATCH", BASE, secret, { bodyHtml: "<p>v2 {{name}}</p>" }),
      withSlug("welcome"),
    );
    const read = await one.GET(req("GET", BASE, secret), withSlug("welcome"));
    const detail = (await read.json()) as {
      version: number;
      versions: { version: number }[];
    };
    expect(detail.version).toBe(2);
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);

    expect(
      (await one.DELETE(req("DELETE", BASE, secret), withSlug("welcome")))
        .status,
    ).toBe(204);
    expect(
      (await one.GET(req("GET", BASE, secret), withSlug("welcome"))).status,
    ).toBe(404);
  });

  it("409 on a duplicate slug and 400 on a bad body", async () => {
    const list = await import("@/app/api/v1/templates/route");
    await list.POST(
      req("POST", BASE, secret, { ...draft, slug: "dupe" }),
      noParams,
    );
    const again = await list.POST(
      req("POST", BASE, secret, { ...draft, slug: "dupe" }),
      noParams,
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      error: {
        code: "conflict",
        message: expect.stringContaining("dupe"),
      },
    });
    const bad = await list.POST(
      req("POST", BASE, secret, { ...draft, slug: "Not A Slug" }),
      noParams,
    );
    expect(bad.status).toBe(400);
  });

  it("404s a patch or a delete of a template that is not there", async () => {
    const one = await import("@/app/api/v1/templates/[slug]/route");
    const patched = await one.PATCH(
      req("PATCH", BASE, secret, { name: "x" }),
      withSlug("ghost"),
    );
    expect(patched.status).toBe(404);
    expect(await patched.json()).toMatchObject({
      error: { code: "not_found" },
    });
    expect(
      (await one.DELETE(req("DELETE", BASE, secret), withSlug("ghost"))).status,
    ).toBe(404);
  });

  it("renders with the caller's variables and 400s when one is missing", async () => {
    const list = await import("@/app/api/v1/templates/route");
    const render = await import("@/app/api/v1/templates/[slug]/render/route");
    await list.POST(
      req("POST", BASE, secret, { ...draft, slug: "render" }),
      noParams,
    );
    const ok = await render.POST(
      req("POST", BASE, secret, { variables: { name: "Ada & Co" } }),
      withSlug("render"),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      subject: "Hi Ada & Co",
      html: "<p>Hello Ada &amp; Co</p>",
      text: null,
    });
    const missing = await render.POST(
      req("POST", BASE, secret, { variables: {} }),
      withSlug("render"),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: { code: "validation_error", details: { missing: ["name"] } },
    });
    expect(
      (await render.POST(req("POST", BASE, secret, {}), withSlug("nope")))
        .status,
    ).toBe(404);
  });

  it("400s a variables payload over a contract cap, naming the field", async () => {
    const render = await import("@/app/api/v1/templates/[slug]/render/route");
    const res = await render.POST(
      req("POST", BASE, secret, {
        variables: { name: "x".repeat(MAX_VARIABLE_VALUE_CHARS + 1) },
      }),
      withSlug("render"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        code: "validation_error",
        message: expect.stringContaining(String(MAX_VARIABLE_VALUE_CHARS)),
        details: { field: "variables" },
      },
    });
  });

  it("413s a render body over the route's own cap, declared or streamed", async () => {
    const render = await import("@/app/api/v1/templates/[slug]/render/route");
    const declared = await render.POST(
      new Request(BASE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "content-length": String(9_000_000),
        },
        body: "{}",
      }),
      withSlug("render"),
    );
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({
      error: { code: "payload_too_large" },
    });

    const big = `{"variables":{"name":"${"x".repeat(400_000)}"}}`;
    const streamed = await render.POST(
      new Request(BASE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(big));
            c.close();
          },
        }),
        // @ts-expect-error `duplex` is required for a streamed body and is
        // not yet in the lib.dom RequestInit typings.
        duplex: "half",
      }),
      withSlug("render"),
    );
    expect(streamed.status).toBe(413);
  });

  it("400s a render body that is not a JSON object", async () => {
    const render = await import("@/app/api/v1/templates/[slug]/render/route");
    const res = await render.POST(
      req("POST", BASE, secret, ["not", "an", "object"]),
      withSlug("render"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "validation_error" },
    });
  });
});
