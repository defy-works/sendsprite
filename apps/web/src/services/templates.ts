import { and, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CampaignBlock,
  MAX_BLOCKS,
  renderBlocks,
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
import { canonicalJson } from "@/lib/canonical-json";
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

/**
 * `design` is stripped rather than returned.
 *
 * The REST surface deals in HTML — `bodyHtml` is what a client sends, what the
 * SDK types say and what the OpenAPI document describes. The block tree is the
 * dashboard editor's own source, and shipping it here would add an
 * undocumented field to a documented response and quietly make it part of the
 * contract. The dashboard reads the snapshot from the service, not from this.
 */
export const publicTemplateVersion = (v: TemplateVersion) => {
  const snapshot = { ...v.snapshot };
  delete snapshot.design;
  return {
    version: v.version,
    snapshot,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
  };
};

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
  design: t.design ?? null,
});

const SNAPSHOT_FIELDS = [
  "name",
  "subject",
  "bodyHtml",
  "bodyText",
  "variablesSchema",
  "design",
] as const;

/**
 * The visual editor's block tree, compiled to the fields that are actually
 * sent.
 *
 * Compiled **here** and not in the caller, so `body_html` and `design` cannot
 * disagree. A server action that rendered the blocks itself and posted both
 * would let the two drift — by a bug, or by a client that simply posted
 * whatever it liked — and the result is a template that shows one thing in the
 * editor and mails another. There is exactly one place that turns blocks into
 * a body, and this is it.
 *
 * `unsubscribe: false` because a template is the body of a transactional send.
 * The marker is substituted per recipient by the campaign fan-out, which is
 * not involved here at all; leaving it in would ship a U+0001 to the inbox.
 */
function compileDesign(
  design: CampaignBlock[],
): Result<{ bodyHtml: string; bodyText: string | null }> {
  const parsed = z.array(CampaignBlock).max(MAX_BLOCKS).safeParse(design);
  if (!parsed.success)
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ??
        "This design contains a block that is not valid.",
    };
  try {
    const { html, text } = renderBlocks(parsed.data, { unsubscribe: false });
    return { ok: true, data: { bodyHtml: html, bodyText: text || null } };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? `This design cannot be rendered: ${e.message}`
          : "This design cannot be rendered.",
    };
  }
}

/**
 * How a write treats `design`.
 *
 * `undefined` leaves the stored design alone (an API client updating a body
 * has no opinion about it); `null` clears it, which is what editing the HTML
 * by hand means; an array replaces it *and* the body compiled from it.
 */
export type DesignPatch = CampaignBlock[] | null | undefined;

/**
 * Substitutes the compiled body into the input **before** it is parsed.
 *
 * The order matters. Compiling after the parse would mean the contract had
 * validated a body nobody sends — a design-authored template has no HTML of
 * its own to submit, and the editor would have to invent a plausible one just
 * to get past `bodyHtml.min(1)`. Compiling first means the contract checks the
 * markup that is actually stored: its length, its placeholder count, all of
 * it. It also removes the last way `body_html` and `design` could disagree —
 * whatever the caller sent for `bodyHtml` is replaced, not merely overridden
 * afterwards.
 */
function withCompiledBody(
  raw: unknown,
  compiled: { bodyHtml: string; bodyText: string | null },
  /** `omit` for a create, where `bodyText` is optional and null is refused. */
  emptyText: "null" | "omit",
): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const rest = { ...raw, bodyHtml: compiled.bodyHtml };
  if (compiled.bodyText !== null)
    return { ...rest, bodyText: compiled.bodyText };
  // A design that renders to nothing has no text part. A create expresses
  // that by omission and an update by `null` — the two schemas disagree, and
  // sending the wrong one is a validation error rather than a silent no-op.
  if (emptyText === "null") return { ...rest, bodyText: null };
  const withoutText: Record<string, unknown> = { ...rest };
  delete withoutText.bodyText;
  return withoutText;
}

/**
 * The snapshot fields whose **value** differs.
 *
 * Structural, not `Object.is`: `variablesSchema` is a jsonb object, and the
 * dashboard editor and `templates push` both re-send the whole template on
 * every save. Reference equality would call each of those an edit and cut a
 * version per save click, which is precisely the history this table is not
 * supposed to keep.
 *
 * `canonicalJson`, not `JSON.stringify`: `variablesSchema` is a jsonb column,
 * and jsonb does not preserve key order — it sorts keys by length then
 * bytewise. The stored row and a freshly parsed input therefore serialise
 * differently for the same value, and a plain stringify would call every save
 * an edit. (This file previously claimed the two orders were stable; they are
 * not. Found while building the campaign editor, which has the same shape.)
 */
const changedFields = (
  before: TemplateSnapshot,
  after: TemplateSnapshot,
): string[] =>
  SNAPSHOT_FIELDS.filter(
    (f) => canonicalJson(before[f]) !== canonicalJson(after[f]),
  );

export async function createTemplate(
  actor: TeamActor,
  raw: unknown,
  design?: DesignPatch,
): Promise<Result<Template>> {
  if (!can(actor.role, "templates.manage")) return DENIED;
  const compiled = design ? compileDesign(design) : null;
  if (compiled && !compiled.ok) return compiled;
  const p = CreateTemplateInput.safeParse(
    compiled ? withCompiledBody(raw, compiled.data, "omit") : raw,
  );
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
    design: design ?? null,
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
  design?: DesignPatch,
): Promise<Result<Template>> {
  if (!can(actor.role, "templates.manage")) return DENIED;
  const compiled = design ? compileDesign(design) : null;
  if (compiled && !compiled.ok) return compiled;
  const p = UpdateTemplateInput.safeParse(
    compiled ? withCompiledBody(raw, compiled.data, "null") : raw,
  );
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
    design: design === undefined ? (current.design ?? null) : design,
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
