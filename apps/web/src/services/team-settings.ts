import { eq } from "drizzle-orm";
import { can } from "@sendsprite/shared";
import { db } from "@/db";
import { teamSettings } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import type { Result } from "@/lib/result";
import type { TeamActor } from "./team";
import { getInstanceSettings } from "./instance-settings";
import { effectiveRetentionDays } from "./retention-policy";

export type TeamSettings = typeof teamSettings.$inferSelect;

const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You do not have permission to change team settings.",
};

/** Null when the team has never had a settings row written. */
export async function getTeamSettings(
  teamId: string,
): Promise<TeamSettings | null> {
  const [row] = await db()
    .select()
    .from(teamSettings)
    .where(eq(teamSettings.teamId, teamId))
    .limit(1);
  return row ?? null;
}

/**
 * Store this team's retention choice, already clamped. The clamp is applied
 * on **write** as well as on read (`runRetentionPurge`) so the settings page
 * shows the team the number that is actually in force rather than the one
 * they asked for.
 */
export async function setTeamRetention(
  actor: TeamActor,
  days: number,
): Promise<Result<TeamSettings>> {
  if (!can(actor.role, "settings.manage")) return DENIED;
  const { retentionDays: max } = await getInstanceSettings();
  const clamped = effectiveRetentionDays(days, max);
  // `$onUpdate` fires only via drizzle `.update()`; an upsert must set
  // `updatedAt` explicitly (see the note on the table itself).
  const set = { retentionDays: clamped, updatedAt: new Date() };
  const [row] = await db()
    .insert(teamSettings)
    .values({ teamId: actor.teamId, ...set })
    .onConflictDoUpdate({ target: teamSettings.teamId, set })
    .returning();
  if (!row) throw new Error("team_settings upsert returned no row");
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "team.retention.update",
    targetType: "team",
    targetId: actor.teamId,
    diff: { retentionDays: { to: clamped } },
    ...actor.meta,
  });
  return { ok: true, data: row };
}
