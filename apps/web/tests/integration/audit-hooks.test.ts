import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_URL = "http://localhost:3000";
  process.env.APP_SECRET = "x".repeat(40);
  process.env.EMAIL_PASSWORD_ENABLED = "true";
  process.env.SIGNUP_MODE = "open";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  const { resetAuthForTests } = await import("@/lib/auth");
  resetAuthForTests();
});
afterAll(async () => {
  await pg.stop();
});

async function signUp(email: string) {
  const { auth } = await import("@/lib/auth");
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password: "correct-horse-battery", name: "H" },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: response.user.id, headers: new Headers({ cookie }) };
}

async function audits(action: string) {
  const { auditLog } = await import("@/db/schema");
  return pg.db.select().from(auditLog).where(eq(auditLog.action, action));
}

// Order-dependent: the second test joins the org created by the first.
describe("organization hooks → audit", () => {
  let ownerHeaders: Headers;
  let ownerId: string;
  let orgId: string;

  it("records team.create on organization creation", async () => {
    const { auth } = await import("@/lib/auth");
    const owner = await signUp("h@example.com");
    ownerHeaders = owner.headers;
    ownerId = owner.userId;
    const org = await auth.api.createOrganization({
      headers: ownerHeaders,
      body: { name: "Hooked", slug: "hooked" },
    });
    if (!org) throw new Error("createOrganization returned null");
    orgId = org.id;
    const rows = await audits("team.create");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teamId: org.id,
      actorUserId: ownerId,
      targetType: "team",
      targetId: org.id,
      diff: { name: { to: "Hooked" }, slug: { to: "hooked" } },
    });
  });

  it("records members.join when an invitation is accepted", async () => {
    const { auth } = await import("@/lib/auth");
    const inv = await auth.api.createInvitation({
      headers: ownerHeaders,
      body: { organizationId: orgId, email: "j@example.com", role: "member" },
    });
    const joiner = await signUp("j@example.com");
    const accepted = await auth.api.acceptInvitation({
      headers: joiner.headers,
      body: { invitationId: inv.id },
    });
    const rows = await audits("members.join");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      teamId: orgId,
      actorUserId: joiner.userId,
      targetType: "member",
      targetId: accepted?.member.id,
      diff: { role: { to: "member" }, invitationId: { to: inv.id } },
    });
  });
});
