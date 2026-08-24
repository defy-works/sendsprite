import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { and, count, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { loadEnv } from "@/env.schema";
import { canSignUp, resolveSignupMode } from "./signup-policy";

const env = loadEnv();

async function currentSignupMode() {
  const [settings] = await db().select().from(schema.instanceSettings).limit(1);
  const [users] = await db().select({ n: count() }).from(schema.user);
  return resolveSignupMode(
    env.SIGNUP_MODE,
    (settings?.signupMode as never) ?? null,
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

export const auth = betterAuth({
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
          const mode = await currentSignupMode();
          const invited =
            mode === "invite" ? await hasPendingInvitation(user.email) : false;
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
        // Default the active team to the user's first membership so /app
        // never renders without a team.
        before: async (session) => {
          const [m] = await db()
            .select({ orgId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, session.userId))
            .limit(1);
          return {
            data: { ...session, activeOrganizationId: m?.orgId ?? null },
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
      // Email delivery arrives in Phase 3; for now the accept link is shown
      // in the UI. Log it so dev/e2e runs can find it.
      sendInvitationEmail: async ({ id, email }) => {
        console.info(`[invite] ${email} → ${env.APP_URL}/invite/${id}`);
      },
    }),
    nextCookies(),
  ],
});

export type Auth = typeof auth;
