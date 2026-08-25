import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { can, newId } from "@sendsprite/shared";
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
  error: "You don't have permission to do that.",
};

const input = z.object({
  name: z.string().trim().min(1, "Name is required.").max(64),
  permission: z.enum(["full", "sending_only"]).default("full"),
  // A form's empty <select> option arrives as ""; treat it as unset.
  domainId: z
    .string()
    .trim()
    .transform((s) => s || undefined)
    .optional(),
});

/** Newest first; includes revoked rows so the UI can show them greyed out. */
export function listApiKeys(teamId: string): Promise<ApiKey[]> {
  return db()
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.teamId, teamId))
    .orderBy(desc(apiKeys.createdAt));
}

/** The secret is returned exactly once; it cannot be recovered afterwards. */
export async function createApiKey(
  actor: TeamActor,
  raw: unknown,
): Promise<Result<{ id: string; secret: string }>> {
  if (!can(actor.role, "apiKeys.create")) return DENIED;
  const p = input.safeParse(raw);
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
  if (!row) return { ok: false, error: "API key not found." };
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
