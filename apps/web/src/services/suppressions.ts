import { and, desc, eq, inArray } from "drizzle-orm";
import {
  AddSuppressionInput,
  can,
  newId,
  type PageQuery,
} from "@sendsprite/shared";
import { db } from "@/db";
import { keysetPage, type Page } from "@/db/keyset";
import { suppressions, type SuppressionReason } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { normaliseEmail } from "@/lib/email-address";
import type { Result } from "@/lib/result";
import type { TeamActor } from "./team";

export type Suppression = typeof suppressions.$inferSelect;
export type { SuppressionReason };

const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You don't have permission to do that.",
};
const UNIQUE = { target: [suppressions.teamId, suppressions.email] };

/** Newest first. */
export function listSuppressions(teamId: string): Promise<Suppression[]> {
  return db()
    .select()
    .from(suppressions)
    .where(eq(suppressions.teamId, teamId))
    .orderBy(desc(suppressions.createdAt));
}

/**
 * REST page, newest first. Keyset paging on `(created_at, id)`; `cursor` is the last returned id.
 */
export const listSuppressionsPage = (
  teamId: string,
  q: PageQuery,
): Promise<Result<Page<Suppression>>> =>
  keysetPage(suppressions, q, eq(suppressions.teamId, teamId));

/** REST shape: no team id. */
export const publicSuppression = (s: Suppression) => ({
  id: s.id,
  email: s.email,
  reason: s.reason,
  note: s.note,
  sourceEmailId: s.sourceEmailId,
  createdAt: s.createdAt,
});

/** The suppressed subset of `emails` (normalised), with each one's reason. */
export async function isSuppressed(
  teamId: string,
  emails: string[],
): Promise<{ email: string; reason: SuppressionReason }[]> {
  const norm = [...new Set(emails.map(normaliseEmail))];
  if (!norm.length) return [];
  return db()
    .select({ email: suppressions.email, reason: suppressions.reason })
    .from(suppressions)
    .where(
      and(eq(suppressions.teamId, teamId), inArray(suppressions.email, norm)),
    );
}

/**
 * System path (SES event ingestion): no permission check, no audit row.
 * Idempotent — an address already on the list keeps its original reason.
 */
export async function suppressFromEvent(
  teamId: string,
  items: { email: string; reason: SuppressionReason }[],
  sourceEmailId: string | null,
): Promise<void> {
  if (!items.length) return;
  await db()
    .insert(suppressions)
    .values(
      items.map((i) => ({
        id: newId("sup"),
        teamId,
        email: normaliseEmail(i.email),
        reason: i.reason,
        sourceEmailId,
      })),
    )
    .onConflictDoNothing(UNIQUE);
}

/**
 * Idempotent: re-adding an address succeeds and returns the existing row.
 * Bounce/complaint entries are written only by `suppressFromEvent`
 * (`AddSuppressionInput` allows manual/unsubscribe).
 */
export async function addSuppression(
  actor: TeamActor,
  raw: unknown,
): Promise<Result<Suppression>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = AddSuppressionInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const { email, reason, note } = p.data;
  const [inserted] = await db()
    .insert(suppressions)
    .values({
      id: newId("sup"),
      teamId: actor.teamId,
      email,
      reason,
      note: note ?? null,
    })
    .onConflictDoNothing(UNIQUE)
    .returning();
  if (!inserted) {
    const [existing] = await db()
      .select()
      .from(suppressions)
      .where(
        and(
          eq(suppressions.teamId, actor.teamId),
          eq(suppressions.email, email),
        ),
      );
    if (!existing) throw new Error("suppression vanished after conflict");
    return { ok: true, data: existing };
  }
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "suppressions.add",
    targetType: "suppression",
    targetId: email,
    diff: { reason: { to: reason } },
  });
  return { ok: true, data: inserted };
}

/**
 * Removal re-enables sending to an address SES already bounced or flagged,
 * so it is admin-only while any member may add.
 */
export async function removeSuppression(
  actor: TeamActor,
  email: string,
): Promise<Result> {
  if (!can(actor.role, "settings.manage")) return DENIED;
  const [row] = await db()
    .delete(suppressions)
    .where(
      and(
        eq(suppressions.teamId, actor.teamId),
        eq(suppressions.email, normaliseEmail(email)),
      ),
    )
    .returning({ email: suppressions.email });
  if (!row)
    return {
      ok: false,
      code: "not_found",
      error: "Not on the suppression list.",
    };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "suppressions.remove",
    targetType: "suppression",
    targetId: row.email,
  });
  return { ok: true, data: undefined };
}
