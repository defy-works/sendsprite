import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  pagedList,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  createTemplate,
  listTemplatesPage,
  publicTemplate,
} from "@/services/templates";

export const dynamic = "force-dynamic";

/**
 * Templates are a management surface, like webhooks and API keys, so every
 * route here needs a `full` key — `POST /:slug/render` included, because it
 * returns template content. A sending-only key sends *with* a template
 * through `POST /emails`, where the render happens server-side, so it never
 * needs to read one.
 */
export const GET = withApiKey(
  (req, auth) =>
    pagedList(req, (q) => listTemplatesPage(auth.team.id, q), publicTemplate),
  { permission: "full" },
);

/** 201 with the template at version 1. A slug already in use is a 409. */
export const POST = withApiKey(
  async (req, auth) => {
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createTemplate(keyActor(auth), json);
    if (!res.ok) return serviceFailure(res);
    return ok(publicTemplate(res.data), { status: 201 });
  },
  { permission: "full" },
);
