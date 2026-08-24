import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { resetEnvCache } from "@/env.schema";
import * as schema from "@/db/schema";
import type { TeamActor } from "@/services/team";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
let svc: typeof import("@/services/team");

let owner: TeamActor;
let ownerHeaders: Headers;
let plain: TeamActor; // role "member"
let plainHeaders: Headers;
let plainMemberId: string;

beforeAll(async () => {
  pg = await startPg();
  process.env.APP_URL = "http://localhost:3000";
  process.env.APP_SECRET = "x".repeat(40);
  process.env.EMAIL_PASSWORD_ENABLED = "true";
  process.env.SIGNUP_MODE = "open";
  resetEnvCache();
  const { auth, resetAuthForTests } = await import("@/lib/auth");
  resetAuthForTests();
  svc = await import("@/services/team");

  const o = await signUp("owner@example.com");
  ownerHeaders = cookieHeaders(o);
  const org = await auth.api.createOrganization({
    headers: ownerHeaders,
    body: { name: "Acme", slug: "acme" },
  });
  if (!org) throw new Error("createOrganization returned null");
  owner = {
    userId: o.response.user.id,
    teamId: org.id,
    teamName: org.name,
    role: "owner",
  };

  const m = await signUp("member@example.com");
  plainHeaders = cookieHeaders(m);
  plainMemberId = `mem_${m.response.user.id}`;
  await pg.db.insert(schema.member).values({
    id: plainMemberId,
    organizationId: org.id,
    userId: m.response.user.id,
    role: "member",
    createdAt: new Date(),
  });
  plain = { ...owner, userId: m.response.user.id, role: "member" };
});
afterAll(async () => {
  await pg.stop();
});

async function signUp(email: string) {
  const { auth } = await import("@/lib/auth");
  return auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: email },
    returnHeaders: true,
  });
}

function cookieHeaders(res: { headers: Headers }) {
  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return new Headers({ cookie: cookies });
}

function audits(action: string) {
  return pg.db
    .select()
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.action, action),
        eq(schema.auditLog.teamId, owner.teamId),
      ),
    )
    .orderBy(desc(schema.auditLog.createdAt));
}

describe("team service", () => {
  it("member role cannot invite", async () => {
    const res = await svc.inviteMember(
      plain,
      plainHeaders,
      "x@example.com",
      "member",
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringMatching(/permission/i),
    });
    expect(await audits("members.invite")).toHaveLength(0);
  });

  it("rejects an invalid email before calling better-auth", async () => {
    const res = await svc.inviteMember(owner, ownerHeaders, "nope", "member");
    expect(res.ok).toBe(false);
  });

  let invitationId: string;

  it("owner invites: pending invitation + audit + link", async () => {
    const res = await svc.inviteMember(
      owner,
      ownerHeaders,
      "new@example.com",
      "admin",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    invitationId = res.data!.link.split("/invite/")[1]!;
    expect(res.data!.link).toBe(`http://localhost:3000/invite/${invitationId}`);
    const [inv] = await pg.db
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.id, invitationId));
    expect(inv).toMatchObject({
      email: "new@example.com",
      role: "admin",
      status: "pending",
      inviterId: owner.userId,
    });
    const [a] = await audits("members.invite");
    expect(a).toMatchObject({
      actorUserId: owner.userId,
      targetType: "invitation",
      targetId: invitationId,
      diff: { email: { to: "new@example.com" }, role: { to: "admin" } },
    });
  });

  it("cancel invitation: status canceled + audit", async () => {
    const res = await svc.cancelInvitation(owner, ownerHeaders, invitationId);
    expect(res).toEqual({ ok: true });
    const [inv] = await pg.db
      .select({ status: schema.invitation.status })
      .from(schema.invitation)
      .where(eq(schema.invitation.id, invitationId));
    expect(inv?.status).toBe("canceled");
    const [a] = await audits("members.invite.cancel");
    expect(a).toMatchObject({ targetId: invitationId });
  });

  it("better-auth's own permission check surfaces as a Result error", async () => {
    // Actor claims admin but the session cookie belongs to a plain member.
    const forged: TeamActor = { ...plain, role: "admin" };
    const res = await svc.inviteMember(
      forged,
      plainHeaders,
      "forged@example.com",
      "member",
    );
    expect(res.ok).toBe(false);
    expect(await audits("members.invite")).toHaveLength(1);
  });

  it("admin cannot promote to owner", async () => {
    const admin: TeamActor = { ...owner, role: "admin" };
    const res = await svc.changeRole(
      admin,
      ownerHeaders,
      plainMemberId,
      "owner",
    );
    expect(res).toEqual({
      ok: false,
      error: expect.stringMatching(/only an owner/i),
    });
    expect(await audits("members.changeRole")).toHaveLength(0);
  });

  it("owner changes a member's role + audit", async () => {
    const res = await svc.changeRole(
      owner,
      ownerHeaders,
      plainMemberId,
      "admin",
    );
    expect(res).toEqual({ ok: true });
    const [m] = await pg.db
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(eq(schema.member.id, plainMemberId));
    expect(m?.role).toBe("admin");
    const [a] = await audits("members.changeRole");
    expect(a).toMatchObject({
      targetId: plainMemberId,
      diff: { role: { to: "admin" } },
    });
  });

  it("member cannot rename", async () => {
    const res = await svc.renameTeam(plain, plainHeaders, "Nope");
    expect(res.ok).toBe(false);
  });

  it("rename: organization.name updated + audit diff", async () => {
    const res = await svc.renameTeam(owner, ownerHeaders, "  Acme Corp ");
    expect(res).toEqual({ ok: true });
    const [org] = await pg.db
      .select({ name: schema.organization.name })
      .from(schema.organization)
      .where(eq(schema.organization.id, owner.teamId));
    expect(org?.name).toBe("Acme Corp");
    const [a] = await audits("team.rename");
    expect(a).toMatchObject({
      targetType: "team",
      targetId: owner.teamId,
      diff: { name: { from: "Acme", to: "Acme Corp" } },
    });
  });

  it("remove member: row gone + audit", async () => {
    const res = await svc.removeMember(owner, ownerHeaders, plainMemberId);
    expect(res).toEqual({ ok: true });
    const rows = await pg.db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.id, plainMemberId));
    expect(rows).toHaveLength(0);
    const [a] = await audits("members.remove");
    expect(a).toMatchObject({ targetId: plainMemberId });
  });
});
