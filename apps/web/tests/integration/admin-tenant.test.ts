/**
 * The rest of `/admin`: the per-team overrides form, the suspend panel, the
 * users table and the instance-admin grant, plus the two reads that feed the
 * pages. Each write is checked where it takes effect — a suspension that only
 * shows in a badge is not a suspension — and each is checked for the audit
 * row it must leave, since reaching across a tenant boundary is the one thing
 * this product must never do quietly.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
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
  return { id, email: `${suffix}@example.com` };
}

async function auditsFor(teamId: string | null, action: string) {
  const { auditLog } = await import("@/db/schema");
  const rows = await pg.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, action));
  return rows.filter((r) => teamId === null || r.teamId === teamId);
}

describe("per-team overrides", () => {
  it("upserts a settings row that did not exist, takes effect, and audits the diff", async () => {
    const { setOrgOverrides, getOrganization } =
      await import("@/services/admin");
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { teamSettings } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    const admin = await makeUser({ instanceAdmin: true });
    // No row yet: the team has never opened its own settings.
    await pg.db.delete(teamSettings).where(eq(teamSettings.teamId, team.id));

    const res = await setOrgOverrides(actor(admin.id), team.id, {
      dailyLimit: 10,
      monthlyLimit: 200,
      retentionDays: 14,
      planOverride: null,
    });
    expect(res).toEqual({ ok: true, data: undefined });
    expect(await resolveTeamCaps(team.id)).toMatchObject({
      daily: 10,
      monthly: 200,
      source: "settings",
    });
    const org = await getOrganization(team.id);
    expect(org).toMatchObject({
      dailyLimit: 10,
      monthlyLimit: 200,
      retentionDays: 14,
    });
    const [audit] = await auditsFor(team.id, "admin.team.overrides");
    expect(audit).toMatchObject({
      actorUserId: admin.id,
      targetId: team.id,
      diff: {
        dailyLimit: { from: null, to: 10 },
        monthlyLimit: { from: null, to: 200 },
        retentionDays: { from: null, to: 14 },
      },
    });
  });

  it("updates an existing row and clears an override with null", async () => {
    const { setOrgOverrides } = await import("@/services/admin");
    const { resolveTeamCaps } = await import("@/services/send-limits");
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    const { team } = await seedTeamWithKey();
    const admin = await makeUser({ instanceAdmin: true });
    await updateInstanceSettings(
      { defaultDailyLimit: null, defaultMonthlyLimit: null },
      undefined,
      { audit: false },
    );
    await setOrgOverrides(actor(admin.id), team.id, {
      dailyLimit: 5,
      monthlyLimit: 50,
      retentionDays: null,
      planOverride: null,
    });
    await setOrgOverrides(actor(admin.id), team.id, {
      dailyLimit: null,
      monthlyLimit: 60,
      retentionDays: null,
      planOverride: null,
    });
    expect(await resolveTeamCaps(team.id)).toMatchObject({
      daily: null,
      monthly: 60,
    });
    const audits = await auditsFor(team.id, "admin.team.overrides");
    expect(audits).toHaveLength(2);
    expect(audits[1]!.diff).toMatchObject({
      dailyLimit: { from: 5, to: null },
      monthlyLimit: { from: 50, to: 60 },
    });
  });
});

describe("suspending a team", () => {
  it("is what `teamSuspension` reports, with the reason, and audits both directions", async () => {
    const { setOrgSuspended, getOrganization } =
      await import("@/services/admin");
    const { teamSuspension } = await import("@/services/send-limits");
    const { teamSettings } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    const admin = await makeUser({ instanceAdmin: true });
    await pg.db.delete(teamSettings).where(eq(teamSettings.teamId, team.id));
    expect(await teamSuspension(team.id)).toBeNull();

    expect(
      await setOrgSuspended(actor(admin.id), team.id, true, "Spam complaints"),
    ).toEqual({ ok: true, data: undefined });
    expect(await teamSuspension(team.id)).toMatchObject({
      reason: "Spam complaints",
    });
    expect(await getOrganization(team.id)).toMatchObject({
      suspendedReason: "Spam complaints",
    });
    expect((await getOrganization(team.id))?.suspendedAt).not.toBeNull();
    expect(await auditsFor(team.id, "admin.team.suspend")).toHaveLength(1);

    // Restoring clears the reason too — a stale reason on a live team is a
    // false accusation on the next operator's screen.
    expect(
      await setOrgSuspended(actor(admin.id), team.id, false, null),
    ).toEqual({
      ok: true,
      data: undefined,
    });
    expect(await teamSuspension(team.id)).toBeNull();
    expect(await getOrganization(team.id)).toMatchObject({
      suspendedAt: null,
      suspendedReason: null,
    });
    expect(await auditsFor(team.id, "admin.team.unsuspend")).toHaveLength(1);
  });

  it("a suspension with no reason is still a suspension", async () => {
    const { setOrgSuspended } = await import("@/services/admin");
    const { teamSuspension } = await import("@/services/send-limits");
    const { team } = await seedTeamWithKey();
    const admin = await makeUser({ instanceAdmin: true });
    await setOrgSuspended(actor(admin.id), team.id, true, null);
    expect(await teamSuspension(team.id)).toMatchObject({ reason: null });
  });
});

describe("the users table", () => {
  it("lists everyone with their team count and ban, newest first, and searches email and name", async () => {
    const { listUsers } = await import("@/services/admin");
    const { member } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    const solo = await makeUser();
    const joined = await makeUser();
    await pg.db.insert(member).values({
      id: `mem_${randomBytes(6).toString("hex")}`,
      organizationId: team.id,
      userId: joined.id,
      role: "member",
      createdAt: new Date(),
    });

    const all = await listUsers();
    const bySolo = all.find((u) => u.id === solo.id)!;
    const byJoined = all.find((u) => u.id === joined.id)!;
    expect(bySolo).toMatchObject({
      teams: 0,
      instanceAdmin: false,
      bannedAt: null,
    });
    expect(byJoined.teams).toBe(1);
    // Newest first: the two just created lead the list.
    expect(
      all
        .slice(0, 2)
        .map((u) => u.id)
        .sort(),
    ).toEqual([solo.id, joined.id].sort());

    // Search hits the email...
    const byEmail = await listUsers(solo.email.slice(0, 6).toUpperCase());
    expect(byEmail.map((u) => u.id)).toEqual([solo.id]);
    // ...and the name, and misses everything else.
    const byName = await listUsers(`User ${joined.id.slice(2, 8)}`);
    expect(byName.map((u) => u.id)).toEqual([joined.id]);
    expect(await listUsers("no-such-person-anywhere")).toEqual([]);
  });
});

describe("the instance-admin flag", () => {
  it("grants, audits, and refuses to remove yourself or the last admin", async () => {
    const { setInstanceAdmin, listUsers } = await import("@/services/admin");
    const { user } = await import("@/db/schema");
    // Start from exactly one flagged admin so "the last one" is well-defined.
    await pg.db.update(user).set({ instanceAdmin: false });
    const first = await makeUser({ instanceAdmin: true });
    const second = await makeUser();

    expect(await setInstanceAdmin(actor(first.id), second.id, true)).toEqual({
      ok: true,
      data: undefined,
    });
    expect(
      (await listUsers()).find((u) => u.id === second.id)?.instanceAdmin,
    ).toBe(true);
    const [audit] = await auditsFor(null, "admin.user.instanceAdmin");
    expect(audit).toMatchObject({
      actorUserId: first.id,
      targetId: second.id,
      diff: {
        email: { to: second.email },
        instanceAdmin: { from: false, to: true },
      },
    });

    // Not yourself.
    const self = await setInstanceAdmin(actor(first.id), first.id, false);
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error).toMatch(/your own/);

    // Down to one again, then that one cannot be removed by anyone.
    expect((await setInstanceAdmin(actor(first.id), second.id, false)).ok).toBe(
      true,
    );
    const last = await setInstanceAdmin(actor(second.id), first.id, false);
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.error).toMatch(/last instance admin/);
    expect(
      (await listUsers()).find((u) => u.id === first.id)?.instanceAdmin,
    ).toBe(true);

    // And there is no such user.
    expect((await setInstanceAdmin(actor(first.id), "u_nobody", true)).ok).toBe(
      false,
    );
  });
});

describe("the reads behind the pages", () => {
  it("getOrganization counts assets by number and bytes, and is null for an unknown id", async () => {
    const { getOrganization } = await import("@/services/admin");
    const { teamAssets } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    expect((await getOrganization(team.id))?.assets).toEqual({
      count: 0,
      bytes: 0,
    });
    for (const size of [1000, 2500])
      await pg.db.insert(teamAssets).values({
        id: `ast_${randomBytes(6).toString("hex")}`,
        teamId: team.id,
        token: randomBytes(32).toString("base64url"),
        contentType: "image/png",
        bytes: Buffer.alloc(size),
        size,
        sha256: randomBytes(32).toString("hex"),
        filename: "x.png",
      });
    expect((await getOrganization(team.id))?.assets).toEqual({
      count: 2,
      bytes: 3500,
    });
    expect(await getOrganization("org_nope")).toBeNull();
  });

  it("instanceStats counts teams, users, domains, suspensions and AWS connections", async () => {
    const { instanceStats, setOrgSuspended } = await import("@/services/admin");
    const before = await instanceStats();
    const { team } = await seedTeamWithKey();
    const admin = await makeUser({ instanceAdmin: true });
    await setOrgSuspended(actor(admin.id), team.id, true, null);
    const after = await instanceStats();
    expect(after.teams).toBe(before.teams + 1);
    expect(after.users).toBeGreaterThan(before.users);
    expect(after.suspended).toBe(before.suspended + 1);
    expect(after.awsConnected).toBe(before.awsConnected);
  });
});
