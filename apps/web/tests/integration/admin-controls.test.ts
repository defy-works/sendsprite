/**
 * The operator's newer controls: banning an account, renaming a team, and the
 * instance-wide send caps.
 *
 * All three change what somebody else can do, which is the reason each one is
 * tested at the point it takes effect rather than at the point it is stored: a
 * ban that only shows in a table is not a ban, and a default limit nothing
 * reads is a number in a form.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  // `resolveTeamCaps` reaches billing config, which parses the environment.
  process.env.APP_URL = "http://localhost:3000";
  process.env.APP_SECRET = "x".repeat(40);
});
afterAll(async () => {
  await pg.stop();
});

const actor = (userId: string) => ({ userId });

async function makeUser(over: { instanceAdmin?: boolean } = {}) {
  const { db } = await import("@/db");
  const { user } = await import("@/db/schema");
  const suffix = randomBytes(6).toString("hex");
  const id = `u_${suffix}`;
  await db()
    .insert(user)
    .values({
      id,
      name: `User ${suffix}`,
      email: `${suffix}@example.com`,
      ...(over.instanceAdmin ? { instanceAdmin: true } : {}),
    });
  return id;
}

describe("banning an account", () => {
  it("stamps the ban, keeps the reason and clears their sessions", async () => {
    const { setUserBanned } = await import("@/services/admin");
    const { db } = await import("@/db");
    const { session, user } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    const target = await makeUser();
    const admin = await makeUser({ instanceAdmin: true });
    await db()
      .insert(session)
      .values({
        id: `s_${randomBytes(6).toString("hex")}`,
        userId: target,
        token: randomBytes(16).toString("hex"),
        expiresAt: new Date(Date.now() + 3600_000),
      });

    expect(
      (await setUserBanned(actor(admin), target, true, "  spam  ")).ok,
    ).toBe(true);

    const [row] = await db()
      .select({ at: user.bannedAt, reason: user.bannedReason })
      .from(user)
      .where(eq(user.id, target));
    expect(row?.at).toBeInstanceOf(Date);
    // Trimmed, because the reason is shown to the person it is about.
    expect(row?.reason).toBe("spam");

    // A ban that takes effect at the next login is not a ban.
    const left = await db()
      .select({ id: session.id })
      .from(session)
      .where(eq(session.userId, target));
    expect(left).toEqual([]);
  });

  it("lifting it clears the reason too", async () => {
    const { setUserBanned } = await import("@/services/admin");
    const { db } = await import("@/db");
    const { user } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    const target = await makeUser();
    const admin = await makeUser({ instanceAdmin: true });
    await setUserBanned(actor(admin), target, true, "spam");
    expect((await setUserBanned(actor(admin), target, false, null)).ok).toBe(
      true,
    );
    const [row] = await db()
      .select({ at: user.bannedAt, reason: user.bannedReason })
      .from(user)
      .where(eq(user.id, target));
    expect(row).toEqual({ at: null, reason: null });
  });

  it("refuses to ban yourself, or another instance admin", async () => {
    const { setUserBanned } = await import("@/services/admin");
    const admin = await makeUser({ instanceAdmin: true });
    const other = await makeUser({ instanceAdmin: true });

    expect(await setUserBanned(actor(admin), admin, true, null)).toMatchObject({
      ok: false,
    });
    // Banning an operator out of the surface that unbans them is not
    // recoverable from inside it.
    expect(await setUserBanned(actor(admin), other, true, null)).toMatchObject({
      ok: false,
    });
  });

  it("writes an audit entry naming the target", async () => {
    const { setUserBanned } = await import("@/services/admin");
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");

    const target = await makeUser();
    const admin = await makeUser({ instanceAdmin: true });
    await setUserBanned(actor(admin), target, true, "abuse");

    const [entry] = await db()
      .select({ action: auditLog.action, diff: auditLog.diff })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetId, target),
          eq(auditLog.action, "admin.user.ban"),
        ),
      );
    expect(entry?.diff).toMatchObject({
      banned: { to: true },
      reason: { to: "abuse" },
    });
  });
});

describe("renaming a team", () => {
  it("changes the name and the slug together", async () => {
    const { renameOrganization } = await import("@/services/admin");
    const { db } = await import("@/db");
    const { organization } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    const admin = await makeUser({ instanceAdmin: true });
    const slug = `renamed-${randomBytes(4).toString("hex")}`;

    expect(
      (
        await renameOrganization(actor(admin), team.id, {
          name: "  Renamed  ",
          slug: slug.toUpperCase(),
        })
      ).ok,
    ).toBe(true);

    const [row] = await db()
      .select({ name: organization.name, slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, team.id));
    // Trimmed, and the slug lower-cased: a slug is an address, not a label.
    expect(row).toEqual({ name: "Renamed", slug });
  });

  it("refuses a slug that is not one, and a name that is blank", async () => {
    const { renameOrganization } = await import("@/services/admin");
    const { team } = await seedTeamWithKey();
    const admin = await makeUser({ instanceAdmin: true });
    for (const slug of ["-leading", "has space", "Ünicode", ""])
      expect(
        await renameOrganization(actor(admin), team.id, { name: "Fine", slug }),
      ).toMatchObject({ ok: false });
    expect(
      await renameOrganization(actor(admin), team.id, {
        name: "   ",
        slug: "fine",
      }),
    ).toMatchObject({ ok: false });
  });

  it("reports a taken slug rather than throwing", async () => {
    const { renameOrganization } = await import("@/services/admin");
    const a = await seedTeamWithKey();
    const b = await seedTeamWithKey();
    const admin = await makeUser({ instanceAdmin: true });
    const res = await renameOrganization(actor(admin), b.team.id, {
      name: "Clash",
      slug: a.team.slug,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("already taken");
  });
});

describe("instance-wide default caps", () => {
  it("apply to a team with no limits of its own", async () => {
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await updateInstanceSettings(
      { defaultDailyLimit: 50, defaultMonthlyLimit: 900 },
      undefined,
      { audit: false },
    );

    const caps = await resolveTeamCaps(team.id);
    expect(caps).toMatchObject({ daily: 50, monthly: 900, source: "instance" });
  });

  it("lose to a limit set on the team", async () => {
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    const { setOrgOverrides } = await import("@/services/admin");
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    const admin = await makeUser({ instanceAdmin: true });
    await updateInstanceSettings(
      { defaultDailyLimit: 50, defaultMonthlyLimit: 900 },
      undefined,
      { audit: false },
    );
    await setOrgOverrides(actor(admin), team.id, {
      dailyLimit: 7,
      monthlyLimit: null,
      retentionDays: null,
    });

    // The team's own daily wins; the monthly it did not set still falls
    // through to the instance default.
    const caps = await resolveTeamCaps(team.id);
    expect(caps).toMatchObject({ daily: 7, monthly: 900, source: "settings" });
  });

  it("are absent by default, which is what it was before", async () => {
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    await updateInstanceSettings(
      { defaultDailyLimit: null, defaultMonthlyLimit: null },
      undefined,
      { audit: false },
    );
    expect(await resolveTeamCaps(team.id)).toMatchObject({
      daily: null,
      monthly: null,
      source: "none",
    });
  });
});
