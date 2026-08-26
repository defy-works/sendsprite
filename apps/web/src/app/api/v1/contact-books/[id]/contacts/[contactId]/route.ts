import { enqueue } from "@/jobs/enqueue";
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
  deleteContact,
  getContact,
  publicContact,
  updateContact,
} from "@/services/contacts";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  async (_req, auth, ctx) => {
    const { id, contactId } = await ctx.params;
    const c = await getContact(auth.team.id, id ?? "", contactId ?? "");
    if (!c) return fail("not_found", "Contact not found.");
    return ok(publicContact(c));
  },
  { permission: "full" },
);

/**
 * `{ subscribed: false }` here is the same consent change as
 * `POST /contacts/unsubscribe`, narrowed to one row — and, like it, it
 * writes no suppression. `true` clears `unsubscribedAt` and the reason.
 */
export const PATCH = withApiKey(
  async (req, auth, ctx) => {
    const { id, contactId } = await ctx.params;
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await updateContact(
      keyActor(auth),
      id ?? "",
      contactId ?? "",
      json,
      { enqueue },
    );
    if (!res.ok) return serviceFailure(res);
    return ok(publicContact(res.data));
  },
  { permission: "full" },
);

export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { id, contactId } = await ctx.params;
    const res = await deleteContact(keyActor(auth), id ?? "", contactId ?? "");
    if (!res.ok) return serviceFailure(res);
    return noContent();
  },
  { permission: "full" },
);
