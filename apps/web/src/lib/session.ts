import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loadEnv } from "@/env.schema";
import { auth } from "./auth";
import { isInstanceAdmin, parseAdminEmails } from "./instance-admin";
import { resolveTeam, type TeamContext } from "./team";

export type { TeamContext } from "./team";

/** Request-scoped: layout and page share one session lookup. */
export const getSession = cache(async () =>
  auth.api.getSession({ headers: await headers() }),
);

const cachedResolveTeam = cache((userId: string, activeId: string | null) =>
  resolveTeam(userId, activeId),
);

/** Redirects to /login when unauthenticated. */
export async function requireSession() {
  const s = await getSession();
  if (!s) redirect("/login");
  return s;
}

/** Resolves the active team; if the user has none, sends them to create one. */
export async function requireTeam(): Promise<TeamContext> {
  const s = await requireSession();
  const ctx = await cachedResolveTeam(
    s.user.id,
    s.session.activeOrganizationId ?? null,
  );
  if (!ctx) redirect("/teams/new");
  return { ...ctx, session: s };
}

/**
 * Connecting a cloud account for the team. Owner **or** admin: the billing
 * owner is often not the engineer who holds the AWS account. Scoped to the
 * *active* team — it no longer means "owner of any team", which was only ever
 * a stand-in for an instance operator while there was one AWS connection.
 * That meaning now lives in `requireInstanceAdmin`.
 */
export async function requireTeamAdmin(): Promise<TeamContext> {
  const ctx = await requireTeam();
  if (ctx.role !== "owner" && ctx.role !== "admin") redirect("/app");
  return ctx;
}

/**
 * Instance-wide settings (signup mode, landing page, the retention ceiling).
 * Deliberately **not** team-derived: with AWS moving onto the team, owning a
 * team says nothing about operating the deployment. Passes on the
 * `INSTANCE_ADMIN_EMAILS` allowlist or the `instanceAdmin` flag; anything
 * else lands back on /app rather than a 403, matching `requireTeamAdmin`.
 *
 * `loadEnv` rather than `@/env`: the latter is `server-only` and throws under
 * the CLI and vitest, which is why `lib/auth.ts` imports it the same way.
 */
export async function requireInstanceAdmin() {
  const s = await requireSession();
  const admins = parseAdminEmails(loadEnv().INSTANCE_ADMIN_EMAILS);
  const flag = (s.user as { instanceAdmin?: boolean }).instanceAdmin === true;
  if (!isInstanceAdmin({ email: s.user.email, flag }, admins)) redirect("/app");
  return s;
}

/**
 * The same resolution as {@link requireTeam}, as a value rather than a
 * redirect.
 *
 * A route handler must not `redirect()`: its caller is `fetch`, and a 307 to
 * `/login` arrives at the editor as an HTML page where JSON was expected. This
 * returns the refusal so the handler can send a status, which is the only
 * difference between the two.
 */
export async function requireApiSession(): Promise<
  | { ok: true; userId: string; teamId: string; role: TeamContext["role"] }
  | { ok: false; response: Response }
> {
  const s = await getSession();
  if (!s)
    return {
      ok: false,
      response: Response.json({ error: "unauthorized" }, { status: 401 }),
    };
  const ctx = await cachedResolveTeam(
    s.user.id,
    s.session.activeOrganizationId ?? null,
  );
  if (!ctx)
    return {
      ok: false,
      response: Response.json({ error: "no_team" }, { status: 403 }),
    };
  return { ok: true, userId: ctx.userId, teamId: ctx.team.id, role: ctx.role };
}
