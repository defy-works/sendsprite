import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
let secret: string;
let sendingOnly: string;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
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
  secret = a.data.secret;
  sendingOnly = b.data.secret;
});
afterAll(async () => {
  await pg.stop();
});

const BASE = "http://localhost/api/v1/suppressions";
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
const withEmail = (email: string) => ({ params: Promise.resolve({ email }) });

describe("REST /api/v1/suppressions", () => {
  it("401 without a key, 403 for a sending-only key", async () => {
    const { GET, POST } = await import("@/app/api/v1/suppressions/route");
    const { DELETE } = await import("@/app/api/v1/suppressions/[email]/route");
    expect((await GET(req("GET"), noParams)).status).toBe(401);
    expect((await GET(req("GET", BASE, sendingOnly), noParams)).status).toBe(
      403,
    );
    expect(
      (
        await POST(
          req("POST", BASE, sendingOnly, { email: "a@x.io" }),
          noParams,
        )
      ).status,
    ).toBe(403);
    expect(
      (await DELETE(req("DELETE", BASE, sendingOnly), withEmail("a@x.io")))
        .status,
    ).toBe(403);
  });

  it("adds (201), rejects bounce/complaint and bad input, lists, deletes by URL-encoded email", async () => {
    const { GET, POST } = await import("@/app/api/v1/suppressions/route");
    const { DELETE } = await import("@/app/api/v1/suppressions/[email]/route");
    const created = await POST(
      req("POST", BASE, secret, {
        email: "Bad+tag@X.io",
        reason: "unsubscribe",
        note: "via api",
      }),
      noParams,
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      email: "bad+tag@x.io",
      reason: "unsubscribe",
      note: "via api",
    });
    for (const body of [
      { email: "b@x.io", reason: "bounce" },
      { email: "b@x.io", reason: "complaint" },
      { email: "nope" },
    ]) {
      const r = await POST(req("POST", BASE, secret, body), noParams);
      expect(r.status).toBe(400);
      expect(await r.json()).toMatchObject({
        error: { code: "validation_error" },
      });
    }
    const notJson = await POST(
      new Request(BASE, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        body: "{nope",
      }),
      noParams,
    );
    expect(notJson.status).toBe(400);

    const list = await GET(req("GET", BASE, secret), noParams);
    expect(list.status).toBe(200);
    const { data } = (await list.json()) as { data: Record<string, unknown>[] };
    expect(data).toHaveLength(1);
    expect(Object.keys(data[0]!).sort()).toEqual([
      "createdAt",
      "email",
      "id",
      "note",
      "reason",
      "sourceEmailId",
    ]);

    const enc = encodeURIComponent("bad+tag@x.io");
    const del = await DELETE(
      req("DELETE", `${BASE}/${enc}`, secret),
      withEmail(enc),
    );
    expect(del.status).toBe(204);
    const again = await DELETE(
      req("DELETE", `${BASE}/${enc}`, secret),
      withEmail(enc),
    );
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
