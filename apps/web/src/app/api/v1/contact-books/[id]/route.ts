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
  deleteBook,
  getBook,
  publicContactBook,
  updateBook,
} from "@/services/contacts";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const b = await getBook(auth.team.id, id ?? "");
    if (!b) return fail("not_found", "Contact book not found.");
    return ok(publicContactBook(b));
  },
  { permission: "full" },
);

/**
 * `updateBook` answers with the stored row; the counts come from a second
 * read, so the response has the same shape as every other book response
 * rather than a version of it missing two fields.
 */
export const PATCH = withApiKey(
  async (req, auth, ctx) => {
    const { id } = await ctx.params;
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await updateBook(keyActor(auth), id ?? "", json);
    if (!res.ok) return serviceFailure(res);
    const b = await getBook(auth.team.id, res.data.id);
    if (!b) return fail("not_found", "Contact book not found.");
    return ok(publicContactBook(b));
  },
  { permission: "full" },
);

/**
 * Cascades every contact in the book away with no history to restore from,
 * so the service asks for `settings.manage` where the other contact
 * mutations ask for `contacts.manage`. The gate is the service's; this
 * handler only maps its refusal to a 403.
 */
export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const res = await deleteBook(keyActor(auth), id ?? "");
    if (!res.ok) return serviceFailure(res);
    return noContent();
  },
  { permission: "full" },
);
