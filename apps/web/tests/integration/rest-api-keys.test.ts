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

const BASE = "http://localhost/api/v1/api-keys";
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

describe("REST /api/v1/api-keys", () => {
  it("401 without a key, 403 for a sending-only key", async () => {
    const { GET, POST } = await import("@/app/api/v1/api-keys/route");
    const r401 = await GET(req("GET"), noParams);
    expect(r401.status).toBe(401);
    expect(await r401.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    const r403 = await GET(req("GET", BASE, sendingOnly), noParams);
    expect(r403.status).toBe(403);
    expect(await r403.json()).toMatchObject({ error: { code: "forbidden" } });
    const p403 = await POST(
      req("POST", BASE, sendingOnly, { name: "x" }),
      noParams,
    );
    expect(p403.status).toBe(403);
  });

  it("lists, creates (201, secret once), validates, and revokes", async () => {
    const { GET, POST } = await import("@/app/api/v1/api-keys/route");
    const { DELETE } = await import("@/app/api/v1/api-keys/[id]/route");
    const list = await GET(req("GET", BASE, secret), noParams);
    expect(list.status).toBe(200);
    const { data } = (await list.json()) as { data: Record<string, unknown>[] };
    expect(data.map((k) => k.name).sort()).toEqual(["root", "send"]);
    expect(Object.keys(data[0]!).sort()).toEqual([
      "createdAt",
      "domainId",
      "id",
      "keyPrefix",
      "lastUsedAt",
      "name",
      "permission",
    ]);
    expect(JSON.stringify(data)).not.toContain("keyHash");

    const created = await POST(
      req("POST", BASE, secret, { name: "ci", permission: "sending_only" }),
      noParams,
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string; secret: string };
    expect(body.secret).toMatch(/^ss_live_/);

    const bad = await POST(req("POST", BASE, secret, { name: "" }), noParams);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: { code: "validation_error" },
    });
    const notJson = await POST(
      new Request(BASE, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}` },
        body: "{nope",
      }),
      noParams,
    );
    expect(notJson.status).toBe(400);

    const del = await DELETE(req("DELETE", `${BASE}/${body.id}`, secret), {
      params: Promise.resolve({ id: body.id }),
    });
    expect(del.status).toBe(204);
    const again = await DELETE(req("DELETE", `${BASE}/${body.id}`, secret), {
      params: Promise.resolve({ id: body.id }),
    });
    expect(again.status).toBe(404);
    const { authenticateApiKey } = await import("@/lib/api-auth");
    expect(await authenticateApiKey(`Bearer ${body.secret}`)).toMatchObject({
      ok: false,
    });
  });
});
