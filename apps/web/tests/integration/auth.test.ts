import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetEnvCache } from "@/env.schema";
import * as schema from "@/db/schema";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_URL = "http://localhost:3000";
  process.env.APP_SECRET = "x".repeat(40);
  process.env.EMAIL_PASSWORD_ENABLED = "true";
  await setSignupMode("auto");
});
afterAll(async () => {
  await pg.stop();
});

/** Env is read once per auth instance, so a mode change needs both caches cleared. */
async function setSignupMode(mode: string) {
  process.env.SIGNUP_MODE = mode;
  resetEnvCache();
  const { resetAuthForTests } = await import("@/lib/auth");
  resetAuthForTests();
}

// Dynamic so `@/lib/auth` is first evaluated after env + DATABASE_URL are set.
async function signUp(email: string) {
  const { auth } = await import("@/lib/auth");
  return auth.api.signUpEmail({
    body: {
      email,
      password: "correct-horse-battery",
      name: email.split("@")[0]!,
    },
  });
}

async function invite(email: string) {
  const [first] = await pg.db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, "first@example.com"));
  const now = new Date();
  const [org] = await pg.db
    .insert(schema.organization)
    .values({ id: "org_1", name: "Team", slug: "team", createdAt: now })
    .onConflictDoNothing()
    .returning({ id: schema.organization.id });
  const orgId = org?.id ?? "org_1";
  await pg.db
    .insert(schema.member)
    .values({
      id: `mem_${first!.id}`,
      organizationId: orgId,
      userId: first!.id,
      role: "owner",
      createdAt: now,
    })
    .onConflictDoNothing();
  await pg.db.insert(schema.invitation).values({
    id: `inv_${email}`,
    organizationId: orgId,
    email,
    role: "member",
    status: "pending",
    expiresAt: new Date(now.getTime() + 60_000),
    inviterId: first!.id,
  });
}

const forbidden = { status: "FORBIDDEN" };

describe("signup policy", () => {
  it("auto: first user may sign up", async () => {
    await expect(signUp("first@example.com")).resolves.toMatchObject({
      user: { email: "first@example.com" },
    });
  });

  it("auto: second user is rejected as invite-only", async () => {
    const attempt = signUp("second@example.com");
    await expect(attempt).rejects.toMatchObject(forbidden);
    await expect(attempt).rejects.toThrow(/invite-only/i);
  });

  it("closed env override rejects even with a pending invitation", async () => {
    await invite("closed@example.com");
    await setSignupMode("closed");
    const attempt = signUp("closed@example.com");
    await expect(attempt).rejects.toMatchObject(forbidden);
    await expect(attempt).rejects.toThrow(/closed/i);
  });

  it("invite mode + pending invitation allows signup", async () => {
    await invite("invited@example.com");
    await setSignupMode("invite");
    await expect(signUp("invited@example.com")).resolves.toMatchObject({
      user: { email: "invited@example.com" },
    });
  });

  it("db override 'open' with env auto allows a further signup", async () => {
    await pg.db
      .insert(schema.instanceSettings)
      .values({ id: 1, signupMode: "open" })
      .onConflictDoUpdate({
        target: schema.instanceSettings.id,
        set: { signupMode: "open" },
      });
    await setSignupMode("auto");
    await expect(signUp("open@example.com")).resolves.toMatchObject({
      user: { email: "open@example.com" },
    });
  });
});
