import { and, eq, isNull } from "drizzle-orm";
import type { ErrorCode } from "@sendsprite/shared";
import { db } from "@/db";
import { apiKeys, organization } from "@/db/schema";
import { hashKey } from "@/services/api-keys";
import type { TeamActor } from "@/services/team";

export type ApiAuthOk = {
  ok: true;
  team: { id: string; name: string };
  key: {
    id: string;
    permission: "full" | "sending_only";
    domainId: string | null;
  };
};
export type ApiAuth =
  ApiAuthOk | { ok: false; code: ErrorCode; message: string };

const BEARER_RE = /^Bearer\s+(ss_live_[A-Za-z0-9_-]{20,})$/;
/** `last_used_at` is written at most this often per key so auth stays one read. */
const LAST_USED_MIN_MS = 60_000;

/**
 * `Authorization: Bearer ss_live_…` → team + key. Never throws on a missing
 * or malformed header; an unknown secret and a revoked key look the same.
 */
export async function authenticateApiKey(
  authorization: string | null | undefined,
): Promise<ApiAuth> {
  const m = BEARER_RE.exec(authorization ?? "");
  if (!m)
    return {
      ok: false,
      code: "unauthorized",
      message: "Missing or malformed API key.",
    };
  const [row] = await db()
    .select({
      key: apiKeys,
      team: { id: organization.id, name: organization.name },
    })
    .from(apiKeys)
    .innerJoin(organization, eq(apiKeys.teamId, organization.id))
    .where(and(eq(apiKeys.keyHash, hashKey(m[1]!)), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row)
    return { ok: false, code: "unauthorized", message: "Invalid API key." };
  const stale =
    !row.key.lastUsedAt ||
    Date.now() - row.key.lastUsedAt.getTime() > LAST_USED_MIN_MS;
  if (stale)
    await db()
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.key.id));
  return {
    ok: true,
    team: row.team,
    key: {
      id: row.key.id,
      permission: row.key.permission,
      domainId: row.key.domainId,
    },
  };
}

/** Management endpoints (keys, domains, webhooks…) need a `full` key. */
export function requireFullPermission(a: ApiAuthOk): ApiAuth {
  return a.key.permission === "full"
    ? a
    : { ok: false, code: "forbidden", message: "This key is sending-only." };
}

/**
 * Service actor for a REST call. Mutations made with a key are audited with
 * actor id `api:<key id>` (the calling key, not a user); a `full` key acts
 * as an admin. No request meta: ip/UA of API clients are not audited yet.
 */
export const keyActor = (auth: ApiAuthOk): TeamActor => ({
  userId: `api:${auth.key.id}`,
  teamId: auth.team.id,
  teamName: auth.team.name,
  role: "admin",
});
