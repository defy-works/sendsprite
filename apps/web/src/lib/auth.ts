import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { and, count, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { loadEnv, type Env } from "@/env.schema";
import { recordAudit } from "@/lib/audit";
// No runtime cycle: `@/lib/team` only `import type`s this module.
import { resolveTeam } from "@/lib/team";
import { canSignUp, resolveSignupMode } from "./signup-policy";

/**
 * Race window: two concurrent *first* signups can both observe zero users
 * and both pass. Accepted for a single-instance self-hosted tool. The hook
 * runs before (outside) the adapter's insert, so a lock taken here would
 * not cover the insert anyway.
 */
async function currentSignupMode(env: Env) {
  const [settings] = await db().select().from(schema.instanceSettings).limit(1);
  const [users] = await db().select({ n: count() }).from(schema.user);
  return resolveSignupMode(
    env.SIGNUP_MODE,
    settings?.signupMode ?? null,
    Number(users?.n ?? 0),
  );
}

async function hasPendingInvitation(email: string) {
  const [row] = await db()
    .select({ id: schema.invitation.id })
    .from(schema.invitation)
    .where(
      and(
        eq(schema.invitation.email, email.toLowerCase()),
        eq(schema.invitation.status, "pending"),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return Boolean(row);
}

// Not `@/env`: that module is `server-only` and throws under the CLI/vitest.
function createAuth() {
  const env = loadEnv();
  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.APP_SECRET,
    database: drizzleAdapter(db(), { provider: "pg", schema }),
    emailAndPassword: {
      enabled: env.providers.emailPassword,
      // Verification mail needs a verified sending domain (Phase 3). Until
      // then accounts are usable immediately.
      requireEmailVerification: false,
    },
    socialProviders: {
      ...(env.providers.google && {
        google: {
          clientId: env.GOOGLE_CLIENT_ID!,
          clientSecret: env.GOOGLE_CLIENT_SECRET!,
        },
      }),
      ...(env.providers.github && {
        github: {
          clientId: env.GITHUB_CLIENT_ID!,
          clientSecret: env.GITHUB_CLIENT_SECRET!,
        },
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const mode = await currentSignupMode(env);
            const invited =
              mode === "invite"
                ? await hasPendingInvitation(user.email)
                : false;
            if (!canSignUp(mode, invited)) {
              throw new APIError("FORBIDDEN", {
                message:
                  mode === "closed"
                    ? "Sign-ups are closed on this instance."
                    : "Sign-ups are invite-only. Ask a team admin for an invitation link.",
              });
            }
            return { data: user };
          },
        },
      },
      session: {
        create: {
          // Defaults activeOrganizationId on later logins using the same
          // rule as `resolveTeam` (oldest membership). The very first session
          // after signup has no membership yet; team creation sets the
          // active org explicitly.
          before: async (session) => {
            const t = await resolveTeam(session.userId, null);
            return {
              data: { ...session, activeOrganizationId: t?.team.id ?? null },
            };
          },
        },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
        creatorRole: "owner",
        invitationExpiresIn: 60 * 60 * 24 * 7,
        // Email delivery arrives in Phase 3; the UI shows the accept link.
        // Log it outside production so dev/e2e runs can find it.
        sendInvitationEmail: async ({ id, email }) => {
          if (env.NODE_ENV !== "production") {
            console.info(`[invite] ${email} → ${env.APP_URL}/invite/${id}`);
          }
        },
        // Mutations that bypass the service layer (org creation, invitation
        // acceptance) are audited here. Rename/invite/remove/changeRole stay
        // in `services/team.ts`, which also carries ip/UA. `recordAudit`
        // never throws, so a failed write cannot break the mutation.
        organizationHooks: {
          afterCreateOrganization: async ({ organization: org, user }) => {
            await recordAudit({
              teamId: org.id,
              actorUserId: user.id,
              action: "team.create",
              targetType: "team",
              targetId: org.id,
              diff: { name: { to: org.name }, slug: { to: org.slug } },
            });
          },
          afterAcceptInvitation: async ({
            invitation: inv,
            member: m,
            user,
          }) => {
            await recordAudit({
              teamId: inv.organizationId,
              actorUserId: user.id,
              action: "members.join",
              targetType: "member",
              targetId: m.id,
              diff: { role: { to: m.role }, invitationId: { to: inv.id } },
            });
          },
        },
      }),
      nextCookies(),
    ],
  });
}

type AuthInstance = ReturnType<typeof createAuth>;
let instance: AuthInstance | undefined;

/** Instantiated on first use so importing this module has no side effects. */
export function getAuth(): AuthInstance {
  return (instance ??= createAuth());
}

/** Test-only: drop the cached instance so the next access re-reads env. */
export function resetAuthForTests() {
  instance = undefined;
}

/**
 * Lazy proxy: property access instantiates on first use. `has` is required
 * because `toNextJsHandler` checks `"handler" in auth` before calling it.
 */
export const auth: AuthInstance = new Proxy({} as AuthInstance, {
  get: (_t, key) => Reflect.get(getAuth(), key),
  has: (_t, key) => key in getAuth(),
  ownKeys: () => Reflect.ownKeys(getAuth()),
  getOwnPropertyDescriptor: (_t, key) => {
    const d = Reflect.getOwnPropertyDescriptor(getAuth(), key);
    return d && { ...d, configurable: true };
  },
});

export type Auth = AuthInstance;
