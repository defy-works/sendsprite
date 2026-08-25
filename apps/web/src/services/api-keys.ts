import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import {
  can,
  CreateApiKeyInput,
  newId,
  type PageQuery,
} from "@sendsprite/shared";
import { db } from "@/db";
import { apiKeys, domains } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import type { Result } from "@/lib/result";
import type { TeamActor } from "./team";

export type ApiKey = typeof apiKeys.$inferSelect;
export type ApiKeyPermission = ApiKey["permission"];

/** Only the sha256 of the secret is stored; lib/api-auth looks keys up by the same hash. */
export const hashKey = (k: string) =>
  createHash("sha256").update(k).digest("hex");

const PREFIX_LEN = 16; // "ss_live_" + 8 chars: enough to tell keys apart in the UI
const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You don't have permission to do that.",
};

/** Newest first; includes revoked rows so the UI can show them greyed out. */
export function listApiKeys(teamId: string): Promise<ApiKey[]> {
  return db()
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.teamId, teamId))
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * REST page of live keys (revoked ones are omitted), newest first.
 * Keyset paging on `(created_at, id)`; `cursor` is the last returned id.
 */
export async function listApiKeysPage(
  teamId: string,
  q: PageQuery,
): Promise<{ data: ApiKey[]; nextCursor: string | null }> {
  const after = q.cursor
    ? await db()
        .select({ createdAt: apiKeys.createdAt, id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.teamId, teamId), eq(apiKeys.id, q.cursor)))
        .then((r) => r[0])
    : undefined;
  const rows = await db()
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.teamId, teamId),
        isNull(apiKeys.revokedAt),
        after
          ? or(
              lt(apiKeys.createdAt, after.createdAt),
              and(
                eq(apiKeys.createdAt, after.createdAt),
                lt(apiKeys.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
    .limit(q.limit + 1);
  const data = rows.slice(0, q.limit);
  return {
    data,
    nextCursor: rows.length > q.limit ? (data.at(-1)?.id ?? null) : null,
  };
}

/** REST shape: never the hash; the prefix is all that identifies the secret. */
export const publicApiKey = (k: ApiKey) => ({
  id: k.id,
  name: k.name,
  permission: k.permission,
  keyPrefix: k.keyPrefix,
  domainId: k.domainId,
  lastUsedAt: k.lastUsedAt,
  createdAt: k.createdAt,
});

/** The secret is returned exactly once; it cannot be recovered afterwards. */
export async function createApiKey(
  actor: TeamActor,
  raw: unknown,
): Promise<Result<{ id: string; secret: string }>> {
  if (!can(actor.role, "apiKeys.create")) return DENIED;
  const p = CreateApiKeyInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  if (p.data.domainId) {
    const [d] = await db()
      .select({ id: domains.id })
      .from(domains)
      .where(
        and(eq(domains.id, p.data.domainId), eq(domains.teamId, actor.teamId)),
      );
    if (!d) return { ok: false, error: "Domain not found." };
  }
  const secret = `ss_live_${randomBytes(32).toString("base64url")}`;
  const id = newId("key");
  await db()
    .insert(apiKeys)
    .values({
      id,
      teamId: actor.teamId,
      name: p.data.name,
      permission: p.data.permission,
      domainId: p.data.domainId ?? null,
      keyPrefix: secret.slice(0, PREFIX_LEN),
      keyHash: hashKey(secret),
      createdBy: actor.userId,
    });
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "apiKeys.create",
    targetType: "apiKey",
    targetId: id,
    diff: { name: { to: p.data.name }, permission: { to: p.data.permission } },
  });
  return { ok: true, data: { id, secret } };
}

export async function revokeApiKey(
  actor: TeamActor,
  id: string,
): Promise<Result> {
  if (!can(actor.role, "apiKeys.revoke")) return DENIED;
  const [row] = await db()
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, id),
        eq(apiKeys.teamId, actor.teamId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  if (!row)
    return { ok: false, code: "not_found", error: "API key not found." };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "apiKeys.revoke",
    targetType: "apiKey",
    targetId: id,
  });
  return { ok: true, data: undefined };
}
