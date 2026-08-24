import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
});
afterAll(async () => {
  await pg.stop();
});

describe("instance settings", () => {
  it("creates the singleton lazily", async () => {
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    const s = await getInstanceSettings();
    expect(s.id).toBe(1);
    expect(s.awsMode).toBe("none");
  });
  it("encrypts secrets at rest and decrypts on read", async () => {
    const { updateInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
    const s = await updateInstanceSettings({
      awsMode: "keys",
      awsAccessKey: "AKIAEXAMPLE",
      awsSecret: "s3cr3t",
    });
    expect(s.awsAccessKeyEnc).toMatch(/^v1\./);
    expect(s.awsAccessKeyEnc).not.toContain("AKIA");
    expect(await getDecryptedSecrets()).toMatchObject({
      awsAccessKey: "AKIAEXAMPLE",
      awsSecret: "s3cr3t",
      cloudflareToken: null,
    });
  });
  it("clears a secret when given null", async () => {
    const { updateInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
    const s = await updateInstanceSettings({ awsSecret: null });
    expect(s.awsSecretEnc).toBeNull();
    expect(s.awsAccessKeyEnc).toMatch(/^v1\./);
    expect((await getDecryptedSecrets()).awsSecret).toBeNull();
  });
  it("leaves secrets untouched on a plain patch", async () => {
    const { updateInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
    const before = await updateInstanceSettings({ cloudflareToken: "cf-tok" });
    const after = await updateInstanceSettings({ awsRegion: "eu-west-1" });
    expect(after.awsRegion).toBe("eu-west-1");
    expect(after.awsAccessKeyEnc).toBe(before.awsAccessKeyEnc);
    expect(after.cloudflareTokenEnc).toBe(before.cloudflareTokenEnc);
    expect((await getDecryptedSecrets()).cloudflareToken).toBe("cf-tok");
  });
  it("writes an instance-level audit row on update", async () => {
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings(
      { retentionDays: 30, awsSecret: "again" },
      { userId: "u_audit", meta: { ip: "10.0.0.1", userAgent: "vitest" } },
    );
    const { auditLog } = await import("@/db/schema");
    const rows = await pg.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "instance.update"));
    expect(rows.at(-1)).toMatchObject({
      teamId: null,
      actorUserId: "u_audit",
      targetType: "instance",
      targetId: "1",
      ip: "10.0.0.1",
      userAgent: "vitest",
      diff: {
        retentionDays: { from: 90, to: 30 },
        awsSecretEnc: { from: "[redacted]", to: "[redacted]" },
      },
    });
    expect(JSON.stringify(rows.at(-1)!.diff)).not.toContain("again");
  });
});
