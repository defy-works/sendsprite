import { z } from "zod";
import { PageQuery } from "./emails";

/**
 * Contracts for `/api/v1/contact-books` and `/api/v1/contacts` (spec §7).
 * Shared with the SDK and the OpenAPI generator, so every schema here must
 * stay `z.toJSONSchema`-representable: `.refine`/`.superRefine` are fine (the
 * emitter ignores them) and `.trim()`/`.toLowerCase()` are `overwrite` checks
 * that keep the string type; a `.transform()` is not. The one transform in
 * this file is on `ListContactsQuery`, which is read off the query string and
 * is never registered as a component schema — its parameters are hand-written.
 *
 * ## A contact's `subscribed` flag is consent. It is not the suppression list.
 *
 * The two are near neighbours and must never be wired to each other:
 *
 * | | `suppressions` (`api/suppressions.ts`) | `contacts.subscribed` (here) |
 * | --- | --- | --- |
 * | Key | `(team_id, email)` — the whole team | `(book_id, email)` — one book |
 * | Means | "this address must not be sent to at all" | "not *this kind of* mail" |
 * | Written by | SES bounce/complaint events, `POST /suppressions` | `POST /contacts/unsubscribe`, the dashboard, CSV import |
 * | Enforced by | `createEmail` — blocks **every** send, transactional included | campaign recipient selection (Phase 7). Blocks nothing today. |
 *
 * **Nothing here writes a suppression, and nothing in `api/suppressions.ts`
 * writes a contact — in either direction.** The failure that rule prevents is
 * concrete: if leaving a newsletter wrote a suppression, that person would
 * stop receiving their password resets and their receipts. That is a support
 * incident, and for receipts a legal one. In the other direction, a hard
 * bounce is not a withdrawal of consent — the address may be a typo in one
 * book while the person is perfectly reachable elsewhere.
 *
 * `SUPPRESSION_REASONS` contains the string `"unsubscribe"`, which is the one
 * trap in the neighbourhood: it means *this address asked to be removed from
 * all mail* (a reply-to-stop, handled by an operator), and it is emphatically
 * not what `POST /contacts/unsubscribe` writes. Unsubscribing a contact
 * touches contact rows and nothing else; `UnsubscribeResult` counts those rows
 * and reports nothing else, because there is nothing else to report.
 *
 * The one place the two legitimately meet is campaign recipient selection,
 * which must skip a contact whose address is suppressed. That is a read-time
 * join, it belongs with campaigns, and it is a Phase 7 opener.
 */

const ADDR_SPEC = '[^\\s@<>"]+@[^\\s@<>"]+\\.[^\\s@<>"]+';
/** `"Name <a@b>"` or a bare address, matching `SendEmailInput`'s shape check. */
const FROM_RE = new RegExp(`^(?:[^<>]*<${ADDR_SPEC}>|${ADDR_SPEC})$`);

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .pipe(z.email("Enter a valid email."));

const fromAddress = z
  .string()
  .trim()
  .max(320)
  .regex(FROM_RE, "Enter a valid from-address.");

/** Up to 20 free-form string properties, 500 characters each. */
const properties = z
  .record(z.string().trim().min(1).max(64), z.string().max(500))
  .refine((p) => Object.keys(p).length <= 20, "At most 20 properties.");

export const CreateContactBookInput = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  /** Suggested sender for campaigns from this book; not used for sending yet. */
  defaultFrom: fromAddress.optional(),
});
export type CreateContactBookInput = z.infer<typeof CreateContactBookInput>;

/** Every field optional, at least one present; `null` clears the from-address. */
export const UpdateContactBookInput = CreateContactBookInput.extend({
  defaultFrom: fromAddress.nullable(),
})
  .partial()
  .refine((o) => Object.keys(o).length > 0, "Nothing to update.");
export type UpdateContactBookInput = z.infer<typeof UpdateContactBookInput>;

export const ContactBookObject = z.object({
  id: z.string(),
  name: z.string(),
  defaultFrom: z.string().nullable(),
  /** Contacts in the book, and how many of them are still subscribed. */
  contactCount: z.number().int(),
  subscribedCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ContactBookObject = z.infer<typeof ContactBookObject>;

export const CreateContactInput = z.object({
  email,
  firstName: z.string().trim().max(120).optional(),
  lastName: z.string().trim().max(120).optional(),
  properties: properties.default({}),
  /**
   * Consent for this book only. `false` here does not — and must not — put the
   * address on the team's suppression list; see the note at the top of this
   * file for what each of the two actually blocks.
   */
  subscribed: z.boolean().default(true),
});
export type CreateContactInput = z.infer<typeof CreateContactInput>;

export const UpdateContactInput = z
  .object({
    firstName: z.string().trim().max(120).nullable(),
    lastName: z.string().trim().max(120).nullable(),
    properties,
    /** Flipping this to `false` is an unsubscribe, never a suppression. */
    subscribed: z.boolean(),
    /** Free text; the dashboard writes "manual", the API whatever the caller sends. */
    unsubscribeReason: z.string().trim().max(200).nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "Nothing to update.");
export type UpdateContactInput = z.infer<typeof UpdateContactInput>;

export const ContactObject = z.object({
  id: z.string(),
  bookId: z.string(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  properties: z.record(z.string(), z.string()),
  /** Consent for this book. A suppressed address is a separate, team-wide fact. */
  subscribed: z.boolean(),
  unsubscribeReason: z.string().nullable(),
  unsubscribedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ContactObject = z.infer<typeof ContactObject>;

/**
 * `?limit&cursor&q&subscribed`; `q` matches the address prefix or either name.
 *
 * The `subscribed` filter is a string enum rather than a coerced boolean so
 * that a typo (`?subscribed=yes`) is a `validation_error` instead of silently
 * meaning `true` — the difference between the two pages is the whole point of
 * the filter. Query schemas are parsed off `URLSearchParams` and never emitted
 * into the OpenAPI components, which is why the transform is allowed here.
 */
export const ListContactsQuery = PageQuery.extend({
  q: z.string().trim().min(1).max(120).optional(),
  subscribed: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type ListContactsQuery = z.infer<typeof ListContactsQuery>;

/**
 * 2 MB of CSV *text*; bigger lists are imported in chunks (see `/docs/contacts`).
 *
 * Characters, not bytes: this bound is applied to an already-decoded JSON
 * string, so a file of multi-byte names is larger on the wire than it is here.
 * The route's own `content-length` refusal is the byte bound, and it fires
 * first — this one exists so the cap holds for every caller of the contract,
 * including the dashboard action and the SDK.
 */
export const MAX_IMPORT_CSV_CHARS = 2 * 1024 * 1024;

/**
 * The message a customer migrating from another ESP will meet on day one, so
 * it says what to do rather than what went wrong, and says that splitting the
 * file costs them nothing.
 */
const CSV_TOO_LARGE =
  "This CSV is larger than 2 MB. Split it into smaller files, each under 2 MB, and import them one after another — every part lands in the same book.";

export const ImportContactsInput = z.object({
  csv: z.string().min(1, "CSV is required.").max(MAX_IMPORT_CSV_CHARS, {
    message: CSV_TOO_LARGE,
  }),
  /** False leaves an address that is already in the book exactly as it is. */
  updateExisting: z.boolean().default(true),
});
export type ImportContactsInput = z.infer<typeof ImportContactsInput>;

export const ImportContactsResult = z.object({
  imported: z.number().int(),
  updated: z.number().int(),
  /** Rows that were parsed but not applied (bad address, or already present). */
  skipped: z.number().int(),
  /** Rows dropped because a later row in the same file had the same address. */
  duplicates: z.number().int(),
  /**
   * The first 100 bad rows, with the line each was on. A malformed row does
   * not fail the import — the good rows still land — so this list is how a
   * customer finds the handful the file got wrong.
   */
  errors: z
    .array(
      z.object({
        line: z.number().int(),
        email: z.string().nullable(),
        reason: z.string(),
      }),
    )
    .max(100),
});
export type ImportContactsResult = z.infer<typeof ImportContactsResult>;

/**
 * `POST /contacts/unsubscribe` — by address, across **every book of the team**
 * unless `bookId` narrows it. The person said stop, not "stop for book A".
 *
 * Idempotent: unsubscribing an address that is already out is a 200 with
 * `unsubscribed: 0`, not a 404 and not an error. Anyone who clicks the link
 * twice, or whose mail client prefetches it, gets the same answer.
 *
 * There is deliberately no field here that adds a suppression, and adding one
 * is not a small convenience — it would silently convert "stop sending me the
 * newsletter" into "stop sending me my password resets". Whoever implements
 * the service behind this contract must leave `suppressions` untouched.
 */
export const UnsubscribeContactInput = z.object({
  email,
  /** Narrow the unsubscribe to one book; omit it to cover the whole team. */
  bookId: z.string().trim().min(1).optional(),
  reason: z.string().trim().max(200).optional(),
});
export type UnsubscribeContactInput = z.infer<typeof UnsubscribeContactInput>;

export const UnsubscribeResult = z.object({
  /**
   * Contact rows changed by this call; 0 when the address was already out.
   * Contact rows only — the call writes no suppression, so there is no second
   * count to report here and no reason to add one.
   */
  unsubscribed: z.number().int(),
});
export type UnsubscribeResult = z.infer<typeof UnsubscribeResult>;
