import { MAX_IMPORT_CSV_CHARS } from "@sendsprite/shared";
import { enqueue } from "@/jobs/enqueue";
import { keyActor } from "@/lib/api-auth";
import { fail, ok, serviceFailure, withApiKey } from "@/lib/api-response";
import { importContacts } from "@/services/contacts";

export const dynamic = "force-dynamic";

/**
 * Largest import body accepted.
 *
 * `ImportContactsInput` bounds the CSV at 2 MB of *characters*, which is up
 * to ~6 MB of UTF-8 for a list of multi-byte names — but the envelope is
 * what arrives on the wire, so the byte cap is the one that has to fire
 * first, and a 4 MB envelope covers the ASCII lists that make up all but the
 * pathological cases while still refusing anything absurd unbuffered. The
 * two caps are deliberately different units and the customer-facing message
 * on the character cap says plainly to split the file.
 *
 * Declaring a cap here rather than inheriting `MAX_BODY_BYTES` matters: that
 * one is 25 MB because a send carries base64 attachments, and this route has
 * none. `api/billing/webhook` is the precedent for a route-specific limit.
 */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

const overCap = () =>
  fail(
    "payload_too_large",
    `Request body must be at most ${MAX_IMPORT_BYTES} bytes; the CSV itself may be at most ${MAX_IMPORT_CSV_CHARS} characters. Split the list into smaller files and import them one after another — every part lands in the same book.`,
  );

/**
 * `POST /contact-books/:id/contacts/import` — CSV inside a JSON envelope.
 *
 * **200, not 201, and never a 4xx for bad rows.** The import is a partial
 * success by design: malformed rows are counted and reported in `errors`
 * while the good rows land, so a file where 90 of 100 rows imported is
 * neither a failure (400 would throw away the 90 that worked, and the
 * customer's next move would be to re-upload the whole file) nor a created
 * resource (201 would claim every row became one). 200 with the report is
 * the honest answer: the request succeeded, and the body says exactly what
 * it did — `imported`, `updated`, `skipped`, `duplicates` and the per-row
 * `errors`, capped at 100 with an entry saying how many were omitted. Only
 * a document that cannot be read at all (an unterminated quote, a missing
 * `email` column) is a 400, because after those nothing that follows can be
 * trusted.
 *
 * The body is capped before it is parsed, then re-checked against the bytes
 * actually read, because a chunked request declares no `content-length` at
 * all — without the second check, an unbounded chunked body would be fully
 * buffered before the contract's own limit could refuse it.
 *
 * The path segment `import` sits beside `[contactId]`; Next matches the
 * static segment first, and contact ids are `ct_<ulid>`, so nothing is
 * shadowed.
 *
 * Consent is the service's business, not this handler's: a `subscribed`
 * column is honoured for new rows and an import can never resubscribe
 * anyone. Nothing here writes a suppression.
 */
export const POST = withApiKey(
  async (req, auth, ctx) => {
    if (Number(req.headers.get("content-length")) > MAX_IMPORT_BYTES)
      return overCap();
    const raw = await req.text();
    if (Buffer.byteLength(raw) > MAX_IMPORT_BYTES) return overCap();

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return fail("validation_error", "Body must be JSON.");
    }

    const { id } = await ctx.params;
    const res = await importContacts(keyActor(auth), id ?? "", json, {
      enqueue,
    });
    if (!res.ok) return serviceFailure(res);
    return ok(res.data);
  },
  { permission: "full" },
);
