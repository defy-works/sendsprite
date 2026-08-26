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

/** Instance-level actions: any owner of any team may perform them (§6.1: "first user"; later owners too). */
export async function requireOwner(): Promise<TeamContext> {
  const ctx = await requireTeam();
  if (ctx.role !== "owner") redirect("/app");
  return ctx;
}

/**
 * Instance-wide settings (signup mode, landing page, the retention ceiling).
 * Deliberately **not** team-derived: with AWS moving onto the team, owning a
 * team says nothing about operating the deployment. Passes on the
 * `INSTANCE_ADMIN_EMAILS` allowlist or the `instanceAdmin` flag; anything
 * else lands back on /app rather than a 403, matching `requireOwner`.
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
