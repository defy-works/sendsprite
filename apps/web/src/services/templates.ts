import { and, desc, eq, or, sql } from "drizzle-orm";
import {
  CreateTemplateInput,
  TemplateVariablesPayload,
  UpdateTemplateInput,
  can,
  newId,
  renderTemplate,
  type PageQuery,
  type RenderedTemplate,
} from "@sendsprite/shared";
import { db } from "@/db";
import { keysetPage, type Page } from "@/db/keyset";
import {
  templateVersions,
  templates,
  type Template,
  type TemplateSnapshot,
  type TemplateVersion,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import type { Result } from "@/lib/result";
import type { TeamActor } from "./team";

export type { Template, TemplateSnapshot, TemplateVersion };

const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You don't have permission to do that.",
};
const NOT_FOUND: Result<never> = {
  ok: false,
  code: "not_found",
  error: "Template not found.",
};

/** Version history kept per template. Older entries stay in the table. */
export const VERSION_PAGE = 20;

/** REST shape: no team id. */
export const publicTemplate = (t: Template) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  subject: t.subject,
  bodyHtml: t.bodyHtml,
  bodyText: t.bodyText,
  variablesSchema: t.variablesSchema,
  version: t.version,
  updatedBy: t.updatedBy,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

export const publicTemplateVersion = (v: TemplateVersion) => ({
  version: v.version,
  snapshot: v.snapshot,
  createdBy: v.createdBy,
  createdAt: v.createdAt,
});

/** Newest first (the dashboard list). */
export const listTemplates = (teamId: string): Promise<Template[]> =>
  db()
    .select()
    .from(templates)
    .where(eq(templates.teamId, teamId))
    .orderBy(desc(templates.createdAt));

/** REST page, newest first; keyset paging on `(created_at, id)`. */
export const listTemplatesPage = (
  teamId: string,
  q: PageQuery,
): Promise<Result<Page<Template>>> =>
  keysetPage(templates, q, eq(templates.teamId, teamId));

/**
 * By slug **or** by id. The REST path segment is the slug (spec §7), but an
 * id is what the dashboard and the SDK have in hand after a create, and
 * accepting both costs one `or`.
 *
 * The two key spaces cannot collide: an id is `tpl_<ulid>` and `TemplateSlug`
 * admits neither an underscore nor an upper-case letter, so no string is both
 * a valid slug and a valid id. The slug is compared lower-cased because that
 * is the form the contract stores; the id is compared verbatim.
 */
export async function getTemplate(
  teamId: string,
  key: string,
): Promise<Template | null> {
  const k = key.trim();
  if (!k) return null;
  const [row] = await db()
    .select()
    .from(templates)
    .where(
      and(
        eq(templates.teamId, teamId),
        or(eq(templates.slug, k.toLowerCase()), eq(templates.id, k)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Newest version first. Empty for a template this team cannot see. */
export async function listTemplateVersions(
  teamId: string,
  key: string,
  limit = VERSION_PAGE,
): Promise<TemplateVersion[]> {
  const t = await getTemplate(teamId, key);
  if (!t) return [];
  return db()
    .select()
    .from(templateVersions)
    .where(eq(templateVersions.templateId, t.id))
    .orderBy(desc(templateVersions.version))
    .limit(limit);
}

/**
 * The five fields a version records — everything about a template except its
 * identity (`id`, `slug`, `team_id`), which never changes, and its bookkeeping
 * (`version`, `updated_by`, timestamps), which the version row carries itself.
 *
 * Deliberately the exact field set of `UpdateTemplateInput`, so a snapshot
 * parses as an update: restoring version N is `updateTemplate(actor, slug,
 * snapshot)`, which appends a new version rather than rewriting history.
 *
 * Always built from the row the database **returned**, never from the values
 * we hoped to write, so a default, a trigger or a concurrent write cannot make
 * the newest snapshot disagree with the live row.
 */
const snapshotOf = (t: Template): TemplateSnapshot => ({
  name: t.name,
  subject: t.subject,
  bodyHtml: t.bodyHtml,
  bodyText: t.bodyText,
  variablesSchema: t.variablesSchema,
});

const SNAPSHOT_FIELDS = [
  "name",
  "subject",
  "bodyHtml",
  "bodyText",
  "variablesSchema",
] as const;

/**
 * The snapshot fields whose **value** differs.
 *
 * Structural, not `Object.is`: `variablesSchema` is a jsonb object, and the
 * dashboard editor and `templates push` both re-send the whole template on
 * every save. Reference equality would call each of those an edit and cut a
 * version per save click, which is precisely the history this table is not
 * supposed to keep. Both sides have been through the same zod object by the
 * time they get here, so their key order — and therefore their serialisation —
 * is stable.
 */
const changedFields = (
  before: TemplateSnapshot,
  after: TemplateSnapshot,
): string[] =>
  SNAPSHOT_FIELDS.filter(
    (f) =>
      JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null),
  );

export async function createTemplate(
  actor: TeamActor,
  raw: unknown,
): Promise<Result<Template>> {
  if (!can(actor.role, "templates.manage")) return DENIED;
  const p = CreateTemplateInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const values = {
    id: newId("tpl"),
    teamId: actor.teamId,
    slug: p.data.slug,
    name: p.data.name,
    subject: p.data.subject,
    bodyHtml: p.data.bodyHtml,
    bodyText: p.data.bodyText ?? null,
    variablesSchema: p.data.variablesSchema,
    version: 1,
    updatedBy: actor.userId,
  };
  let row: Template;
  try {
    // One transaction: a template with no version 1 would be a template with
    // no history, and the conflict below is the common path on a retry.
    row = await db().transaction(async (tx) => {
      const [t] = await tx.insert(templates).values(values).returning();
      if (!t) throw new Error("templates insert returned no row");
      await tx.insert(templateVersions).values({
        templateId: t.id,
        version: t.version,
        snapshot: snapshotOf(t),
        createdBy: actor.userId,
      });
      return t;
    });
  } catch (e) {
    if (pgCode(e) === "23505")
      return {
        ok: false,
        code: "conflict",
        error: `A template with the slug "${p.data.slug}" already exists.`,
      };
    throw e;
  }
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "templates.create",
    targetType: "template",
    targetId: row.slug,
    diff: { slug: { to: row.slug }, name: { to: row.name } },
  });
  return { ok: true, data: row };
}

/**
 * A content change bumps `version` and appends a snapshot; a no-op update
 * (same values, or `name` alone re-submitted unchanged) does neither, so the
 * history is a record of real edits rather than of save clicks.
 *
 * `slug` cannot be changed: a live `POST /emails` names a template by slug, so
 * a rename is a silent outage. Renaming is create-then-delete.
 */
export async function updateTemplate(
  actor: TeamActor,
  key: string,
  raw: unknown,
): Promise<Result<Template>> {
  if (!can(actor.role, "templates.manage")) return DENIED;
  const p = UpdateTemplateInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const current = await getTemplate(actor.teamId, key);
  if (!current) return NOT_FOUND;
  const next: TemplateSnapshot = {
    name: p.data.name ?? current.name,
    subject: p.data.subject ?? current.subject,
    bodyHtml: p.data.bodyHtml ?? current.bodyHtml,
    bodyText:
      p.data.bodyText === undefined ? current.bodyText : p.data.bodyText,
    variablesSchema: p.data.variablesSchema ?? current.variablesSchema,
  };
  const fields = changedFields(snapshotOf(current), next);
  if (!fields.length) return { ok: true, data: current };
  const row = await db().transaction(async (tx) => {
    // The bump is computed by Postgres on the row it locks, not from the read
    // above: two concurrent edits then get 2 and 3 rather than both claiming 2
    // and colliding on `template_versions`' primary key.
    const [t] = await tx
      .update(templates)
      .set({
        ...next,
        version: sql`${templates.version} + 1`,
        updatedBy: actor.userId,
      })
      .where(eq(templates.id, current.id))
      .returning();
    if (!t) return null; // deleted between the read and the write
    await tx.insert(templateVersions).values({
      templateId: t.id,
      version: t.version,
      snapshot: snapshotOf(t),
      createdBy: actor.userId,
    });
    return t;
  });
  if (!row) return NOT_FOUND;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "templates.update",
    targetType: "template",
    targetId: row.slug,
    // Bodies can be megabytes; the audit row records *which* fields moved and
    // to what version, not the content. The snapshots are the content.
    diff: {
      fields: { to: fields.join(", ") },
      version: { from: current.version, to: row.version },
    },
  });
  return { ok: true, data: row };
}

export async function deleteTemplate(
  actor: TeamActor,
  key: string,
): Promise<Result> {
  if (!can(actor.role, "templates.manage")) return DENIED;
  const current = await getTemplate(actor.teamId, key);
  if (!current) return NOT_FOUND;
  // `template_versions` cascades; `emails.template_id` is `set null`, so the
  // mail log keeps every message that was sent from it.
  const [row] = await db()
    .delete(templates)
    .where(eq(templates.id, current.id))
    .returning({ slug: templates.slug, version: templates.version });
  if (!row) return NOT_FOUND;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "templates.delete",
    targetType: "template",
    targetId: row.slug,
    diff: { version: { from: row.version } },
  });
  return { ok: true, data: undefined };
}

/**
 * Renders a stored template without sending or storing anything.
 *
 * The single seam between a stored row and the pure renderer: the dashboard
 * preview, `POST /templates/:slug/render` and the send path all come through
 * here, so a preview cannot differ from what is sent. Nothing above this line
 * gets to choose the source text, the escaping or the declared schema — all
 * three are read from the row, and the only input a caller supplies is the
 * variables.
 *
 * Those variables are re-parsed against the shared caps here rather than
 * trusted from the edge. A server action is as much a caller as a REST route,
 * and the caps are what stop 500 placeholder occurrences × one large value
 * from allocating far past the renderer's own output limit.
 */
export async function renderStoredTemplate(
  teamId: string,
  key: string,
  variables: unknown = {},
): Promise<Result<RenderedTemplate>> {
  const t = await getTemplate(teamId, key);
  if (!t) return NOT_FOUND;
  return renderTemplateRow(t, variables);
}

/**
 * The same seam, for a caller that already holds the row.
 *
 * The send path reads the template itself because it stores `template_id`
 * beside the rendered body, and it must render the very row it recorded — a
 * second read to render could land on a version the id no longer describes.
 * Splitting the body out rather than duplicating it keeps that caller on the
 * one code path a preview also goes through.
 */
export function renderTemplateRow(
  t: Template,
  variables: unknown = {},
): Result<RenderedTemplate> {
  const v = TemplateVariablesPayload.safeParse(variables ?? {});
  if (!v.success)
    return {
      ok: false,
      code: "validation_error",
      error: v.error.issues[0]?.message ?? "Invalid variables.",
      details: { field: "variables" },
    };
  const r = renderTemplate(
    { subject: t.subject, bodyHtml: t.bodyHtml, bodyText: t.bodyText },
    v.data,
    t.variablesSchema,
  );
  if (!r.ok)
    return {
      ok: false,
      code: "validation_error",
      error: r.error,
      details: { field: "variables", missing: r.missing, invalid: r.invalid },
    };
  return { ok: true, data: r.data };
}

/** Postgres SQLSTATE, on the driver error or (drizzle) its `cause`. */
const pgCode = (e: unknown): string | undefined => {
  const o = e as { code?: string; cause?: { code?: string } } | null;
  return o?.code ?? o?.cause?.code;
};
