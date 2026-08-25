import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";

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

describe("api keys", () => {
  it("creates a key shown once, stores only its hash, authenticates requests, tracks last use", async () => {
    const { createApiKey, listApiKeys } = await import("@/services/api-keys");
    const res = await createApiKey(actor, { name: "prod", permission: "full" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.secret).toMatch(/^ss_live_[A-Za-z0-9_-]{40,}$/);
    const { apiKeys } = await import("@/db/schema");
    const [row] = await pg.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, res.data.id));
    expect(row!.keyHash).not.toContain(res.data.secret);
    expect(row!.keyPrefix).toBe(res.data.secret.slice(0, 16));
    const { authenticateApiKey } = await import("@/lib/api-auth");
    const auth = await authenticateApiKey(`Bearer ${res.data.secret}`);
    expect(auth).toMatchObject({
      ok: true,
      team: { id: "org_1" },
      key: { id: res.data.id, permission: "full" },
    });
    expect((await listApiKeys("org_1"))[0]!.lastUsedAt).toBeTruthy();
    expect(await authenticateApiKey("Bearer ss_live_nope")).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    expect(await authenticateApiKey("")).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    expect(await authenticateApiKey(null)).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
  });

  it("revoked keys stop working; members cannot create keys", async () => {
    const { createApiKey, revokeApiKey } = await import("@/services/api-keys");
    const res = await createApiKey(actor, { name: "tmp" });
    if (!res.ok) throw new Error(res.error);
    expect((await revokeApiKey(actor, res.data.id)).ok).toBe(true);
    // Revoking twice (or an unknown id) is a not-found, not a silent success.
    expect((await revokeApiKey(actor, res.data.id)).ok).toBe(false);
    const { authenticateApiKey } = await import("@/lib/api-auth");
    expect(await authenticateApiKey(`Bearer ${res.data.secret}`)).toMatchObject(
      { ok: false },
    );
    expect(
      (await createApiKey({ ...actor, role: "member" }, { name: "x" })).ok,
    ).toBe(false);
    expect(
      (await revokeApiKey({ ...actor, role: "member" }, res.data.id)).ok,
    ).toBe(false);
  });

  it("rejects bad input and a domain from another team", async () => {
    const { createApiKey } = await import("@/services/api-keys");
    expect((await createApiKey(actor, { name: "" })).ok).toBe(false);
    expect(
      (await createApiKey(actor, { name: "x", permission: "root" })).ok,
    ).toBe(false);
    expect(
      (await createApiKey(actor, { name: "x", domainId: "dom_nope" })).ok,
    ).toBe(false);
  });
});
