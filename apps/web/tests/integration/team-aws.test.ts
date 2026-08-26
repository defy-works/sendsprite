import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
let teamId: string;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  teamId = (await seedTeamWithKey()).team.id;
});
afterAll(async () => {
  await pg.stop();
});

const connect = {
  region: "us-east-1",
  accessKey: "AKIAEXAMPLE",
  secret: "s3cr3t",
  configSet: "sendsprite-acme",
  connectedAt: new Date(),
};

describe("team aws", () => {
  it("is null before a connection", async () => {
    const { getTeamAws } = await import("@/services/team-aws");
    expect(await getTeamAws(teamId)).toBeNull();
  });

  it("encrypts the keys at rest and decrypts on read", async () => {
    const { updateTeamAws, getTeamAwsSecrets } =
      await import("@/services/team-aws");
    const row = await updateTeamAws(teamId, connect);
    expect(row.accessKeyEnc).toMatch(/^v1\./);
    expect(row.accessKeyEnc).not.toContain("AKIA");
    expect(row.secretEnc).not.toContain("s3cr3t");
    expect(await getTeamAwsSecrets(teamId)).toMatchObject({
      accessKey: "AKIAEXAMPLE",
      secret: "s3cr3t",
    });
  });

  it("leaves the keys untouched on a plain patch", async () => {
    const { updateTeamAws } = await import("@/services/team-aws");
    const before = await updateTeamAws(teamId, {});
    const after = await updateTeamAws(teamId, { sesDailyQuota: 200 });
    expect(after.sesDailyQuota).toBe(200);
    expect(after.accessKeyEnc).toBe(before.accessKeyEnc);
    expect(after.secretEnc).toBe(before.secretEnc);
  });

  it("scopes rows to their team", async () => {
    const other = (await seedTeamWithKey()).team.id;
    const { getTeamAws, getTeamAwsSecrets } =
      await import("@/services/team-aws");
    expect(await getTeamAws(other)).toBeNull();
    expect(await getTeamAwsSecrets(other)).toBeNull();
  });

  it("writes a team-scoped audit row naming the action", async () => {
    const { updateTeamAws } = await import("@/services/team-aws");
    await updateTeamAws(
      teamId,
      { sesDailyQuota: 300 },
      { userId: "u_a", meta: { ip: "10.0.0.1", userAgent: "vitest" } },
      { action: "aws.connect" },
    );
    const { auditLog } = await import("@/db/schema");
    const rows = await pg.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "aws.connect"));
    expect(rows.at(-1)).toMatchObject({
      teamId,
      actorUserId: "u_a",
      targetType: "team_aws",
      ip: "10.0.0.1",
    });
  });

  it("redacts the ciphertext out of the audit diff", async () => {
    const { updateTeamAws } = await import("@/services/team-aws");
    await updateTeamAws(teamId, { secret: "rotated" }, { userId: "u_a" });
    const { auditLog } = await import("@/db/schema");
    const rows = await pg.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "aws.update"));
    const diff = JSON.stringify(rows.at(-1)?.diff ?? {});
    // The rotation registers, but neither plaintext nor ciphertext leaks.
    expect(diff).toContain("secretEnc");
    expect(diff).not.toContain("rotated");
    expect(diff).not.toContain("v1.");
  });

  it("skips the audit row for a bookkeeping write", async () => {
    const { auditLog } = await import("@/db/schema");
    const before = await pg.db.select().from(auditLog);
    const { updateTeamAws } = await import("@/services/team-aws");
    await updateTeamAws(teamId, { sesLastCheckedAt: new Date() }, undefined, {
      audit: false,
    });
    expect(await pg.db.select().from(auditLog)).toHaveLength(before.length);
  });

  it("disconnect deletes the row and audits it", async () => {
    const { disconnectTeamAws, getTeamAws } =
      await import("@/services/team-aws");
    await disconnectTeamAws(teamId, { userId: "u_a" });
    expect(await getTeamAws(teamId)).toBeNull();
    const { auditLog } = await import("@/db/schema");
    const rows = await pg.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "aws.disconnect"));
    expect(rows.at(-1)).toMatchObject({ teamId });
  });

  it("disconnecting an unconnected team is a no-op", async () => {
    const { disconnectTeamAws } = await import("@/services/team-aws");
    await expect(disconnectTeamAws(teamId)).resolves.toBeUndefined();
  });
});
