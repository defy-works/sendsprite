import { keyActor } from "@/lib/api-auth";
import {
  fail,
  noContent,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  deleteTemplate,
  getTemplate,
  listTemplateVersions,
  publicTemplate,
  publicTemplateVersion,
  updateTemplate,
} from "@/services/templates";

export const dynamic = "force-dynamic";

/**
 * The template and its version history, newest first.
 *
 * The path segment is the slug, but a `tpl_…` id works too: the two key
 * spaces cannot collide, and an id is what a client holds right after a
 * create (`services/templates.ts` explains it).
 */
export const GET = withApiKey(
  async (_req, auth, ctx) => {
    const { slug } = await ctx.params;
    const t = await getTemplate(auth.team.id, slug ?? "");
    if (!t) return fail("not_found", "Template not found.");
    return ok({
      ...publicTemplate(t),
      versions: (await listTemplateVersions(auth.team.id, t.id)).map(
        publicTemplateVersion,
      ),
    });
  },
  { permission: "full" },
);

/**
 * Partial update. A content change bumps `version` and appends a snapshot;
 * an update that changes nothing does neither. `slug` is not accepted — a
 * live send names a template by slug, so a rename is a create plus a delete.
 */
export const PATCH = withApiKey(
  async (req, auth, ctx) => {
    const { slug } = await ctx.params;
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await updateTemplate(keyActor(auth), slug ?? "", json);
    if (!res.ok) return serviceFailure(res);
    return ok(publicTemplate(res.data));
  },
  { permission: "full" },
);

/** Emails already sent from it keep their bodies; their `templateId` is nulled. */
export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { slug } = await ctx.params;
    const res = await deleteTemplate(keyActor(auth), slug ?? "");
    if (!res.ok) return serviceFailure(res);
    return noContent();
  },
  { permission: "full" },
);
