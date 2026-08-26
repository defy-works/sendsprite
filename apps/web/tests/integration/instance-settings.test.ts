import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
});
afterAll(async () => {
  await pg.stop();
});

/**
 * The singleton holds only what belongs to whoever operates the deployment.
 * AWS and Cloudflare moved to `team_aws` / `team_cloudflare` — their storage,
 * encryption and audit behaviour are covered in `team-aws.test.ts` and
 * `cloudflare-connect.test.ts`.
 */
describe("instance settings", () => {
  it("creates the singleton lazily with operator defaults", async () => {
    const { getInstanceSettings } = await import(
      "@/services/instance-settings"
    );
    const s = await getInstanceSettings();
    expect(s.id).toBe(1);
    expect(s.signupMode).toBeNull();
    expect(s.landingEnabled).toBeNull();
    // The retention ceiling, not a per-team default.
    expect(s.retentionDays).toBe(90);
  });

  it("updates plain columns", async () => {
    const { updateInstanceSettings } = await import(
      "@/services/instance-settings"
    );
    const s = await updateInstanceSettings({
      signupMode: "invite",
      landingEnabled: false,
      retentionDays: 30,
    });
    expect(s).toMatchObject({
      signupMode: "invite",
      landingEnabled: false,
      retentionDays: 30,
    });
  });

  it("leaves untouched columns alone on a partial patch", async () => {
    const { updateInstanceSettings } = await import(
      "@/services/instance-settings"
    );
    const after = await updateInstanceSettings({ retentionDays: 45 });
    expect(after).toMatchObject({
      signupMode: "invite",
      landingEnabled: false,
      retentionDays: 45,
    });
  });

  it("writes an instance-level audit row on update", async () => {
    const { updateInstanceSettings } = await import(
      "@/services/instance-settings"
    );
    await updateInstanceSettings(
      { retentionDays: 50 },
      { userId: "u_audit", meta: { ip: "10.0.0.1", userAgent: "vitest" } },
    );
    const { auditLog } = await import("@/db/schema");
    const rows = await pg.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "instance.update"));
    expect(rows.at(-1)).toMatchObject({
      // Instance-level, so no team.
      teamId: null,
      actorUserId: "u_audit",
      targetType: "instance",
      targetId: "1",
      ip: "10.0.0.1",
      diff: { retentionDays: { from: 45, to: 50 } },
    });
  });

  it("skips the audit row when opts.audit is false", async () => {
    const { auditLog } = await import("@/db/schema");
    const before = await pg.db.select().from(auditLog);
    const { updateInstanceSettings } = await import(
      "@/services/instance-settings"
    );
    await updateInstanceSettings({ retentionDays: 55 }, undefined, {
      audit: false,
    });
    expect(await pg.db.select().from(auditLog)).toHaveLength(before.length);
  });

  it("names the audit row after opts.action when given", async () => {
    const { updateInstanceSettings } = await import(
      "@/services/instance-settings"
    );
    const { auditLog } = await import("@/db/schema");
    await updateInstanceSettings({ retentionDays: 60 }, { userId: "u1" }, {
      action: "test.action",
    });
    const rows = await pg.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "test.action"))
      .orderBy(desc(auditLog.createdAt));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetType: "instance",
      diff: { retentionDays: { from: 55, to: 60 } },
    });
  });
});
