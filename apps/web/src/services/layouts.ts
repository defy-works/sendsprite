import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  CampaignBlock,
  CampaignTheme,
  MAX_BLOCKS,
  newId,
} from "@sendsprite/shared";
import { db } from "@/db";
import { teamLayouts, type TeamLayout } from "@/db/schema";
import { recordAudit, type RequestMeta } from "@/lib/audit";
import { pgCode } from "@/lib/pg";
import type { Result } from "@/lib/result";

/**
 * A team's saved block arrangements.
 *
 * The built-in presets live in `lib/editor/layouts.ts` as values; these are
 * the ones a team makes for itself, which is where the feature earns its
 * keep — everybody's footer is different, and re-typing an address into every
 * campaign is exactly the kind of work software should absorb.
 *
 * `blocks` is validated against the contract on the way in. That is not
 * belt-and-braces: a layout is inserted into a body without further checking,
 * so a layout holding an invalid block would produce a body that fails to
 * render, and the author would meet that failure in a campaign they did not
 * write the broken part of.
 */

export const MAX_LAYOUT_NAME = 80;
/** Per team. A layout picker is a list somebody reads, not a search index. */
export const MAX_LAYOUTS = 50;

export interface LayoutActor {
  userId: string;
  teamId: string;
  meta?: RequestMeta;
}

export interface SavedLayout {
  id: string;
  name: string;
  blocks: CampaignBlock[];
  theme: CampaignTheme | null;
  createdAt: Date;
}

const shape = (l: TeamLayout): SavedLayout => ({
  id: l.id,
  name: l.name,
  blocks: l.blocks,
  theme: l.theme ?? null,
  createdAt: l.createdAt,
});

const LayoutInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the layout a name.")
    .max(
      MAX_LAYOUT_NAME,
      `A name may be at most ${MAX_LAYOUT_NAME} characters.`,
    ),
  blocks: z
    .array(CampaignBlock)
    .min(1, "A layout needs at least one block.")
    .max(MAX_BLOCKS, `A layout may hold at most ${MAX_BLOCKS} blocks.`),
  theme: CampaignTheme.nullish(),
});

export const listLayouts = async (teamId: string): Promise<SavedLayout[]> =>
  (
    await db()
      .select()
      .from(teamLayouts)
      .where(eq(teamLayouts.teamId, teamId))
      .orderBy(asc(teamLayouts.name))
  ).map(shape);

export async function saveLayout(
  actor: LayoutActor,
  raw: unknown,
): Promise<Result<SavedLayout>> {
  const p = LayoutInput.safeParse(raw);
  if (!p.success)
    return {
      ok: false,
      error: p.error.issues[0]?.message ?? "Invalid layout.",
    };

  const existing = await db()
    .select({ id: teamLayouts.id })
    .from(teamLayouts)
    .where(eq(teamLayouts.teamId, actor.teamId));
  if (existing.length >= MAX_LAYOUTS)
    return {
      ok: false,
      error: `A team may keep ${MAX_LAYOUTS} layouts. Delete one first.`,
    };

  try {
    const [row] = await db()
      .insert(teamLayouts)
      .values({
        id: newId("lay"),
        teamId: actor.teamId,
        name: p.data.name,
        blocks: p.data.blocks,
        theme: p.data.theme ?? null,
        createdBy: actor.userId,
      })
      .returning();
    if (!row) return { ok: false, error: "The layout could not be saved." };
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      action: "layouts.create",
      targetType: "layout",
      targetId: row.id,
      diff: { name: { to: row.name }, blocks: { to: p.data.blocks.length } },
      ...actor.meta,
    });
    return { ok: true, data: shape(row) };
  } catch (e) {
    // The unique index on (team_id, name). Reported rather than silently
    // overwriting: two layouts called "Footer" is a coin flip, and replacing
    // the old one without asking loses work.
    if (pgCode(e) === "23505")
      return {
        ok: false,
        code: "conflict",
        error: `This team already has a layout called "${p.data.name}".`,
      };
    throw e;
  }
}

export async function deleteLayout(
  actor: LayoutActor,
  id: string,
): Promise<Result> {
  const [row] = await db()
    .delete(teamLayouts)
    .where(and(eq(teamLayouts.id, id), eq(teamLayouts.teamId, actor.teamId)))
    .returning({ name: teamLayouts.name });
  if (!row) return { ok: false, error: "That layout is already gone." };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "layouts.delete",
    targetType: "layout",
    targetId: id,
    diff: { name: { from: row.name } },
    ...actor.meta,
  });
  return { ok: true, data: undefined };
}
