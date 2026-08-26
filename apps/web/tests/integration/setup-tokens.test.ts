import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { user } from "@/db/schema";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  await pg.db.insert(user).values([
    { id: "u1", name: "One", email: "u1@example.com" },
    { id: "u2", name: "Two", email: "u2@example.com" },
    { id: "u3", name: "Three", email: "u3@example.com" },
  ]);
  // setup_tokens.team_id is a real FK now: a token names the team its stack
  // will connect.
  const { organization } = await import("@/db/schema");
  await pg.db.insert(organization).values([
    { id: "org_1", name: "Acme", slug: "acme", createdAt: new Date() },
    { id: "org_2", name: "Beta", slug: "beta", createdAt: new Date() },
  ]);
});
afterAll(async () => {
  await pg.stop();
});

describe("setup tokens", () => {
  it("issues a token that can be consumed exactly once", async () => {
    const { issueSetupToken, consumeSetupToken } =
      await import("@/services/setup-tokens");
    const { token, id } = await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u1",
      teamId: "org_1",
      region: "us-east-1",
      ttlMs: 60_000,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    const first = await consumeSetupToken("aws_callback", token);
    expect(first).toMatchObject({ id, region: "us-east-1", issuedBy: "u1" });
    expect(await consumeSetupToken("aws_callback", token)).toBeNull();
  });
  it("lets only one of two concurrent consumers win", async () => {
    const { issueSetupToken, consumeSetupToken } =
      await import("@/services/setup-tokens");
    const { token } = await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u1",
      teamId: "org_1",
      region: "us-east-1",
      ttlMs: 60_000,
    });
    const results = await Promise.all([
      consumeSetupToken("aws_callback", token),
      consumeSetupToken("aws_callback", token),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("rejects expired and unknown tokens", async () => {
    const { issueSetupToken, consumeSetupToken } =
      await import("@/services/setup-tokens");
    const { token } = await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u1",
      teamId: "org_1",
      region: "us-east-1",
      ttlMs: -1,
    });
    expect(await consumeSetupToken("aws_callback", token)).toBeNull();
    expect(await consumeSetupToken("aws_callback", "nope")).toBeNull();
  });
  it("reports the latest pending token for a user", async () => {
    const { issueSetupToken, pendingSetupToken, consumeSetupToken } =
      await import("@/services/setup-tokens");
    expect(await pendingSetupToken("aws_callback", "u2", "org_1")).toBeNull();
    await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u2",
      teamId: "org_1",
      region: "us-east-1",
      ttlMs: 60_000,
    });
    const { token, id } = await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u2",
      teamId: "org_1",
      region: "eu-west-1",
      ttlMs: 60_000,
    });
    expect(await pendingSetupToken("aws_callback", "u2", "org_1")).toMatchObject({ id });
    await consumeSetupToken("aws_callback", token);
    expect(await pendingSetupToken("aws_callback", "u2", "org_1")).not.toMatchObject({
      id,
    });
  });
  it("revokes every pending token for a user and leaves other users alone", async () => {
    const {
      issueSetupToken,
      consumeSetupToken,
      pendingSetupToken,
      revokePendingSetupTokens,
    } = await import("@/services/setup-tokens");
    const mk = (issuedBy: string, teamId = "org_1") =>
      issueSetupToken({
        purpose: "aws_callback",
        issuedBy,
        teamId,
        region: "us-east-1",
        ttlMs: 60_000,
      });
    const a1 = await mk("u3");
    const a2 = await mk("u3");
    const other = await mk("u2");
    expect(await revokePendingSetupTokens("aws_callback", "u3", "org_1")).toBe(2);
    expect(await pendingSetupToken("aws_callback", "u3", "org_1")).toBeNull();
    expect(await consumeSetupToken("aws_callback", a1.token)).toBeNull();
    expect(await consumeSetupToken("aws_callback", a2.token)).toBeNull();
    expect(await consumeSetupToken("aws_callback", other.token)).not.toBeNull();
    expect(await revokePendingSetupTokens("aws_callback", "u3", "org_1")).toBe(0);
  });
  it("drops tokens when the issuing user is deleted", async () => {
    const { issueSetupToken, consumeSetupToken } =
      await import("@/services/setup-tokens");
    const { token } = await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u3",
      teamId: "org_1",
      region: "us-east-1",
      ttlMs: 60_000,
    });
    await pg.db.delete(user).where(eq(user.id, "u3"));
    expect(await consumeSetupToken("aws_callback", token)).toBeNull();
  });
});
