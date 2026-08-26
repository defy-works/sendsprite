import { ListContactsQuery } from "@sendsprite/shared";
import { enqueue } from "@/jobs/enqueue";
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  createContact,
  listContactsPage,
  publicContact,
} from "@/services/contacts";

export const dynamic = "force-dynamic";

/**
 * `{ data, nextCursor }`, newest first. `?q=` matches an address prefix or
 * either name, `?subscribed=true|false` filters by consent — a string enum,
 * so `?subscribed=yes` is a 400 rather than quietly meaning `true`. The
 * paging is `parsePage`'s, reached through `ListContactsQuery`, which
 * extends `PageQuery`; `pagedList` is not used because the extra filters
 * need parsing in the same pass.
 */
export const GET = withApiKey(
  async (req, auth, ctx) => {
    const { id } = await ctx.params;
    const q = ListContactsQuery.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!q.success)
      return fail(
        "validation_error",
        q.error.issues[0]?.message ?? "Invalid query.",
        q.error.issues,
      );
    const page = await listContactsPage(auth.team.id, id ?? "", q.data);
    if (!page.ok) return serviceFailure(page);
    return ok({
      data: page.data.data.map(publicContact),
      nextCursor: page.data.nextCursor,
    });
  },
  { permission: "full" },
);

/** 201 with the contact; an address already in this book is a 409. */
export const POST = withApiKey(
  async (req, auth, ctx) => {
    const { id } = await ctx.params;
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createContact(keyActor(auth), id ?? "", json, {
      enqueue,
    });
    if (!res.ok) return serviceFailure(res);
    return ok(publicContact(res.data), { status: 201 });
  },
  { permission: "full" },
);
