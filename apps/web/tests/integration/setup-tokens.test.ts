import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
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
      region: "us-east-1",
      ttlMs: -1,
    });
    expect(await consumeSetupToken("aws_callback", token)).toBeNull();
    expect(await consumeSetupToken("aws_callback", "nope")).toBeNull();
  });
  it("reports the latest pending token for a user", async () => {
    const { issueSetupToken, pendingSetupToken, consumeSetupToken } =
      await import("@/services/setup-tokens");
    expect(await pendingSetupToken("aws_callback", "u2")).toBeNull();
    await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u2",
      region: "us-east-1",
      ttlMs: 60_000,
    });
    const { token, id } = await issueSetupToken({
      purpose: "aws_callback",
      issuedBy: "u2",
      region: "eu-west-1",
      ttlMs: 60_000,
    });
    expect(await pendingSetupToken("aws_callback", "u2")).toMatchObject({ id });
    await consumeSetupToken("aws_callback", token);
    expect(await pendingSetupToken("aws_callback", "u2")).not.toMatchObject({
      id,
    });
  });
});
