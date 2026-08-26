"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import {
  can,
  type CampaignBlock,
  type TemplateVariablesSchema,
} from "@sendsprite/shared";
import { requestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { requireTeam } from "@/lib/session";
import * as templates from "@/services/templates";
import { sendTemplateTest } from "@/services/test-send";

export type { Result } from "@/lib/result";

/** Server actions are thin: resolve the actor, delegate, revalidate. */
async function actor() {
  const ctx = await requireTeam();
  return {
    userId: ctx.userId,
    teamId: ctx.team.id,
    teamName: ctx.team.name,
    role: ctx.role,
    meta: requestMeta(await headers()),
  };
}

const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You don't have permission to do that.",
};

/** What the editor sends. Every field is validated again by the service. */
export interface TemplateDraft {
  /** Create only: `slug` is immutable, so an update never carries one. */
  slug?: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  variablesSchema: TemplateVariablesSchema;
  /**
   * The visual editor's blocks, when the template is authored that way.
   *
   * `null` means "authored as HTML" and clears any stored design; the service
   * treats an absent value as "leave it alone", which is the API client's
   * case, not the editor's. When blocks are given the service compiles them
   * and ignores `bodyHtml` — the two cannot be allowed to disagree.
   */
  design?: CampaignBlock[] | null;
}

/** The fields a restore put back, so the open editor can adopt them without a reload. */
export interface RestoredTemplate {
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variablesSchema: TemplateVariablesSchema;
  /** `null` when that version was authored as HTML. */
  design: CampaignBlock[] | null;
}

export async function createTemplate(
  draft: TemplateDraft,
): Promise<Result<{ slug: string }>> {
  const { design, ...fields } = draft;
  const res = await templates.createTemplate(
    await actor(),
    {
      ...fields,
      // An empty textarea means "no text body", not "an empty one".
      bodyText: draft.bodyText.trim() ? draft.bodyText : undefined,
    },
    design,
  );
  if (!res.ok) return res;
  revalidatePath("/app/templates");
  return { ok: true, data: { slug: res.data.slug } };
}

export async function updateTemplate(
  slug: string,
  draft: TemplateDraft,
): Promise<Result> {
  const res = await templates.updateTemplate(
    await actor(),
    slug,
    {
      name: draft.name,
      subject: draft.subject,
      bodyHtml: draft.bodyHtml,
      // `null`, not `undefined`: clearing the text body has to be expressible.
      bodyText: draft.bodyText.trim() ? draft.bodyText : null,
      variablesSchema: draft.variablesSchema,
    },
    draft.design,
  );
  if (!res.ok) return res;
  revalidatePath(`/app/templates/${slug}`);
  revalidatePath("/app/templates");
  return { ok: true, data: undefined };
}

export async function deleteTemplate(slug: string): Promise<Result> {
  const res = await templates.deleteTemplate(await actor(), slug);
  if (res.ok) revalidatePath("/app/templates");
  return res;
}

/**
 * Restoring is an ordinary update carrying an old snapshot's fields, so it
 * appends a *new* version rather than rewinding — the record of what was live
 * and when stays complete, and the restore is itself undoable.
 *
 * The permission check is repeated here, ahead of the version lookup, for the
 * reason `services/templates.ts` checks before its own lookup: an actor who
 * may not manage templates must not learn from the error message whether a
 * slug exists. `updateTemplate` would refuse them anyway, one step too late.
 *
 * The window searched is `VERSION_PAGE`, the same page the editor renders, so
 * every version with a Restore button is a version this can find. A version
 * that has since fallen out of that page says so rather than restoring the
 * wrong one.
 */
export async function restoreVersion(
  slug: string,
  version: number,
): Promise<Result<RestoredTemplate>> {
  const a = await actor();
  if (!can(a.role, "templates.manage")) return DENIED;
  const found = (
    await templates.listTemplateVersions(a.teamId, slug, templates.VERSION_PAGE)
  ).find((v) => v.version === version);
  if (!found)
    return {
      ok: false,
      code: "not_found",
      error:
        "That version is no longer in the recent history. Reload the page and try again.",
    };
  // The snapshot carries the design it was authored with (or `null` for a
  // version written as HTML), and it is passed explicitly: `updateTemplate`
  // treats an absent `design` as "leave it alone", which on a restore would
  // keep today's blocks while reverting the body they no longer compile to.
  const res = await templates.updateTemplate(
    a,
    slug,
    found.snapshot,
    found.snapshot.design ?? null,
  );
  if (!res.ok) return res;
  revalidatePath(`/app/templates/${slug}`);
  revalidatePath("/app/templates");
  // Read back off the row the database returned, not off the snapshot we
  // sent, so the editor adopts what is actually live.
  return {
    ok: true,
    data: {
      name: res.data.name,
      subject: res.data.subject,
      bodyHtml: res.data.bodyHtml,
      bodyText: res.data.bodyText,
      variablesSchema: res.data.variablesSchema,
      design: res.data.design ?? null,
    },
  };
}

/**
 * Sends one copy of a saved template.
 *
 * Unlike the campaign version this needs the template to exist: `createEmail`
 * reads the row itself so the mail log records which template and which
 * version produced the message. Testing an unsaved edit would mean inventing a
 * second render path whose output nothing else uses — the editor asks for a
 * save first instead.
 */
export async function sendTemplateTestAction(
  slug: string,
  input: { to: string[]; from: string; variables: Record<string, unknown> },
): Promise<Result<{ emailId: string }>> {
  const a = await actor();
  if (!can(a.role, "templates.manage")) return DENIED;
  const res = await sendTemplateTest(
    { teamId: a.teamId, userId: a.userId },
    { to: input.to, from: input.from, slug, variables: input.variables },
  );
  if (res.ok) revalidatePath("/app/emails");
  return res.ok ? { ok: true, data: { emailId: res.data.emailId } } : res;
}
