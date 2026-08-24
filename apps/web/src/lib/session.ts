import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
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
