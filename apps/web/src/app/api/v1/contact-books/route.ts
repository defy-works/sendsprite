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
  createBook,
  listBooksPage,
  publicContactBook,
} from "@/services/contacts";

export const dynamic = "force-dynamic";

/**
 * Contact books are a management surface, like webhooks and API keys, so
 * every route under `/contact-books` and `/contacts` needs a `full` key.
 *
 * Nothing here — or anywhere under these paths — writes a suppression. A
 * contact's `subscribed` flag is consent for one book; a suppression stops
 * every send to an address, transactional included. `POST /suppressions` is
 * the endpoint for that, and it is a different endpoint on purpose.
 */
export const GET = withApiKey(
  (req, auth) =>
    pagedList(req, (q) => listBooksPage(auth.team.id, q), publicContactBook),
  { permission: "full" },
);

/** 201 with the book and its (zero) counts. */
export const POST = withApiKey(
  async (req, auth) => {
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createBook(keyActor(auth), json);
    if (!res.ok) return serviceFailure(res);
    return ok(publicContactBook(res.data), { status: 201 });
  },
  { permission: "full" },
);
