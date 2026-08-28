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

function cookieHeaders(res: { headers: Headers }) {
  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return new Headers({ cookie: cookies });
}

async function invite(
  email: string,
  expiresAt = new Date(Date.now() + 60_000),
) {
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
    expiresAt,
    inviterId: first!.id,
  });
}

const forbidden = { status: "FORBIDDEN" };

// Order-dependent: each test builds on the users/invitations of the previous ones.
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

  it("invite mode rejects an expired invitation", async () => {
    await invite("expired@example.com", new Date(Date.now() - 60_000));
    await expect(signUp("expired@example.com")).rejects.toMatchObject(
      forbidden,
    );
  });

  it("later sign-in defaults activeOrganizationId to the first membership", async () => {
    const { auth } = await import("@/lib/auth");
    const res = await auth.api.signInEmail({
      body: { email: "first@example.com", password: "correct-horse-battery" },
      returnHeaders: true,
    });
    const session = await auth.api.getSession({ headers: cookieHeaders(res) });
    expect(session?.session.activeOrganizationId).toBe("org_1");
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

// Regression: the lazy proxy must satisfy `"handler" in auth` (next-js handler).
describe("route handler", () => {
  it("auth.handler answers /api/auth/ok", async () => {
    const { auth } = await import("@/lib/auth");
    const res = await auth.handler(
      new Request("http://localhost:3000/api/auth/ok"),
    );
    expect(res.status).toBe(200);
  });

  it("POST route signs up a user (DB override still open)", async () => {
    const { POST } = await import("@/app/api/auth/[...all]/route");
    const res = await POST(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify({
          email: "route@example.com",
          password: "correct-horse-battery",
          name: "route",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/better-auth/);
    await expect(res.json()).resolves.toMatchObject({
      user: { email: "route@example.com" },
    });
  });
});

/**
 * Runs last: it reads the users the blocks above created, and the final test
 * signs one more up. `first@example.com` was the very first account on this
 * instance, so it must carry the flag; nobody after it may.
 */
describe("instance admin flag", () => {
  const flagOf = async (email: string) => {
    const [row] = await pg.db
      .select({ flag: schema.user.instanceAdmin })
      .from(schema.user)
      .where(eq(schema.user.email, email));
    return row?.flag;
  };

  it("flags the first user to sign up", async () => {
    expect(await flagOf("first@example.com")).toBe(true);
  });

  it("does not flag later users", async () => {
    expect(await flagOf("invited@example.com")).toBe(false);
    expect(await flagOf("route@example.com")).toBe(false);
  });

  it("flags nobody when INSTANCE_ADMIN_EMAILS is set", async () => {
    // Wipe every user so this signup is genuinely "the first", isolating the
    // env allowlist as the only reason the flag stays off.
    await pg.db.delete(schema.user);
    process.env.INSTANCE_ADMIN_EMAILS = "ops@example.com";
    await setSignupMode("open");
    await expect(signUp("solo@example.com")).resolves.toMatchObject({
      user: { email: "solo@example.com" },
    });
    expect(await flagOf("solo@example.com")).toBe(false);
    delete process.env.INSTANCE_ADMIN_EMAILS;
    await setSignupMode("open");
  });

  it("flags the first user when the allowlist is empty", async () => {
    await pg.db.delete(schema.user);
    await expect(signUp("fresh@example.com")).resolves.toMatchObject({
      user: { email: "fresh@example.com" },
    });
    expect(await flagOf("fresh@example.com")).toBe(true);
  });
});

describe("oauth account linking", () => {
  // Drives better-auth's post-callback logic directly: a fake provider
  // profile for an email that already has a password account. Real
  // providers cannot be reached from a test, and this is the exact function
  // /api/auth/callback/:id hands the profile to.
  async function oauthLogin(providerId: "google" | "github", email: string) {
    const { auth } = await import("@/lib/auth");
    const { handleOAuthUserInfo } = await import("better-auth/oauth2");
    const context = await auth.$context;
    const c = {
      context,
      request: new Request(
        "http://localhost:3000/api/auth/callback/" + providerId,
      ),
      setCookie() {},
      setSignedCookie() {},
      getSignedCookie() {
        return null;
      },
    } as unknown as Parameters<typeof handleOAuthUserInfo>[0];
    return handleOAuthUserInfo(c, {
      userInfo: {
        id: `${providerId}-id-1`,
        email,
        name: "Linked",
        emailVerified: true,
        image: null,
      },
      account: {
        providerId,
        accountId: `${providerId}-id-1`,
        issuer: providerId,
      } as Parameters<typeof handleOAuthUserInfo>[1]["account"],
      callbackURL: "/app",
      source: { method: "oauth", oauth: { providerId } },
    });
  }

  it("links a verified provider login to an existing password account", async () => {
    await setSignupMode("open");
    await signUp("linkme@example.com");
    for (const provider of ["google", "github"] as const) {
      const result = await oauthLogin(provider, "linkme@example.com");
      expect(result.error, provider).toBeFalsy();
      expect(result.data?.user.email).toBe("linkme@example.com");
    }
    const users = await pg.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, "linkme@example.com"));
    expect(users).toHaveLength(1);
    const accounts = await pg.db
      .select({ providerId: schema.account.providerId })
      .from(schema.account)
      .where(eq(schema.account.userId, users[0]!.id));
    expect(accounts.map((a) => a.providerId).sort()).toEqual([
      "credential",
      "github",
      "google",
    ]);
  });
});
