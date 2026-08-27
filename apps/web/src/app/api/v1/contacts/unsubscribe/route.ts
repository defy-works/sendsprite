import { enqueue } from "@/jobs/enqueue";
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import { unsubscribeContact } from "@/services/contacts";

export const dynamic = "force-dynamic";

/**
 * `POST /contacts/unsubscribe` — consent, not deliverability.
 *
 * It records that a person does not want a *kind* of mail, across every book
 * of the team unless `bookId` narrows it: the person said stop, not "stop
 * for book A".
 *
 * **It writes no suppression row, and nothing may be added here that does.**
 * A suppression is `(team_id, email)` and blocks every send to an address,
 * transactional included — so if leaving a newsletter wrote one, that person
 * would stop receiving their password resets and their receipts. That is a
 * support incident, and for receipts a legal one. `POST /suppressions` is
 * the endpoint that stops all mail to an address, and it stays a separate,
 * deliberate act. This handler imports `services/contacts` and nothing else;
 * an "also suppress" convenience flag is not a small addition, it is the
 * failure this separation exists to prevent.
 *
 * Idempotent: an address that is already out changes no rows and answers
 * `{ unsubscribed: 0 }` with a 200 — a link clicked twice, or prefetched by
 * a mail client, is not an error. An address in no book of the team is the
 * same 200 with 0, not a 404: this endpoint reports how many rows changed,
 * and "none" is an answer rather than a missing resource.
 */
export const POST = withApiKey(
  async (req, auth) => {
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await unsubscribeContact(keyActor(auth), json, { enqueue });
    if (!res.ok) return serviceFailure(res);
    return ok(res.data);
  },
  { permission: "full" },
);
