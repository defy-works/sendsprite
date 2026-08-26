import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  CreateContactBookInput,
  CreateContactInput,
  ImportContactsInput,
  UnsubscribeContactInput,
  UpdateContactBookInput,
  UpdateContactInput,
  can,
  newId,
  type ImportContactsResult,
  type ListContactsQuery,
  type PageQuery,
  type UnsubscribeResult,
  type WebhookEventType,
} from "@sendsprite/shared";
import { db } from "@/db";
import { keysetPage, type Page } from "@/db/keyset";
import {
  contactBooks,
  contacts,
  type Contact,
  type ContactBook,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { parseCsv } from "@/lib/csv";
import { normaliseEmail } from "@/lib/email-address";
import type { Result } from "@/lib/result";
import type { Enqueue } from "./domains";
import { fanOutEvent } from "./webhooks";
import type { TeamActor } from "./team";

/**
 * Contact books, contacts, CSV import and the team-wide unsubscribe.
 *
 * ## `subscribed` is consent. It is not the suppression list.
 *
 * A suppression is `(team_id, email)`, means "never send to this address at
 * all", and blocks transactional mail too — `createEmail` enforces it. A
 * contact's `subscribed` flag is `(book_id, email)` and means "not *this kind*
 * of mail"; in this phase it blocks nothing, and campaign recipient selection
 * (Phase 7) is what will read it. **Nothing here writes a suppression, and
 * nothing in `services/suppressions.ts` writes a contact.** If leaving a
 * newsletter wrote a suppression, that person would stop receiving their
 * password resets and their receipts. `SUPPRESSION_REASONS` contains the
 * string `"unsubscribe"` — it means "remove from all mail", which is a
 * different thing from anything in this file, and it is the one trap in the
 * neighbourhood. See `packages/shared/src/api/contacts.ts`.
 *
 * ## Permissions
 *
 * `contacts.manage` (members and up) for every mutation, except deleting a
 * book: that cascades a whole audience away in one statement with no history
 * to restore from, so it additionally needs `settings.manage`.
 */

export type { Contact, ContactBook };
export interface ContactDeps {
  enqueue: Enqueue;
  now?: Date;
}

const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You don't have permission to do that.",
};
const NO_BOOK: Result<never> = {
  ok: false,
  code: "not_found",
  error: "Contact book not found.",
};
const NO_CONTACT: Result<never> = {
  ok: false,
  code: "not_found",
  error: "Contact not found.",
};
const BOOK_UNIQUE = { target: [contacts.bookId, contacts.email] };

/** Rows applied per statement during an import. */
const IMPORT_CHUNK = 500;
/** Errors reported back; matches `ImportContactsResult.errors`' cap. */
const MAX_IMPORT_ERRORS = 100;

export interface ContactBookWithCounts extends ContactBook {
  contactCount: number;
  subscribedCount: number;
}

export const publicContactBook = (b: ContactBookWithCounts) => ({
  id: b.id,
  name: b.name,
  defaultFrom: b.defaultFrom,
  contactCount: b.contactCount,
  subscribedCount: b.subscribedCount,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

export const publicContact = (c: Contact) => ({
  id: c.id,
  bookId: c.bookId,
  email: c.email,
  firstName: c.firstName,
  lastName: c.lastName,
  properties: c.properties,
  subscribed: c.subscribed,
  unsubscribeReason: c.unsubscribeReason,
  unsubscribedAt: c.unsubscribedAt,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

/** One grouped count query, then a lookup — never a count per book. */
async function countsFor(
  bookIds: string[],
): Promise<Map<string, { contactCount: number; subscribedCount: number }>> {
  const out = new Map<
    string,
    { contactCount: number; subscribedCount: number }
  >();
  if (!bookIds.length) return out;
  const rows = await db()
    .select({
      bookId: contacts.bookId,
      contactCount: sql<number>`count(*)::int`,
      subscribedCount: sql<number>`count(*) filter (where ${contacts.subscribed})::int`,
    })
    .from(contacts)
    .where(inArray(contacts.bookId, bookIds))
    .groupBy(contacts.bookId);
  for (const r of rows)
    out.set(r.bookId, {
      contactCount: r.contactCount,
      subscribedCount: r.subscribedCount,
    });
  return out;
}

const withCounts = (
  books: ContactBook[],
  counts: Map<string, { contactCount: number; subscribedCount: number }>,
): ContactBookWithCounts[] =>
  books.map((b) => ({
    ...b,
    contactCount: counts.get(b.id)?.contactCount ?? 0,
    subscribedCount: counts.get(b.id)?.subscribedCount ?? 0,
  }));

/** Newest first, with counts (the dashboard list). */
export async function listBooks(
  teamId: string,
): Promise<ContactBookWithCounts[]> {
  const books = await db()
    .select()
    .from(contactBooks)
    .where(eq(contactBooks.teamId, teamId))
    .orderBy(desc(contactBooks.createdAt));
  return withCounts(books, await countsFor(books.map((b) => b.id)));
}

/** REST page, newest first; keyset paging on `(created_at, id)`. */
export async function listBooksPage(
  teamId: string,
  q: PageQuery,
): Promise<Result<Page<ContactBookWithCounts>>> {
  const page = await keysetPage(
    contactBooks,
    q,
    eq(contactBooks.teamId, teamId),
  );
  if (!page.ok) return page;
  const counts = await countsFor(page.data.data.map((b) => b.id));
  return {
    ok: true,
    data: { ...page.data, data: withCounts(page.data.data, counts) },
  };
}

export async function getBook(
  teamId: string,
  bookId: string,
): Promise<ContactBookWithCounts | null> {
  const [row] = await db()
    .select()
    .from(contactBooks)
    .where(and(eq(contactBooks.teamId, teamId), eq(contactBooks.id, bookId)));
  if (!row) return null;
  return withCounts(
    [row],
    await countsFor([row.id]),
  )[0] as ContactBookWithCounts;
}

export async function createBook(
  actor: TeamActor,
  raw: unknown,
): Promise<Result<ContactBookWithCounts>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = CreateContactBookInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const id = newId("cb");
  const [row] = await db()
    .insert(contactBooks)
    .values({
      id,
      teamId: actor.teamId,
      name: p.data.name,
      defaultFrom: p.data.defaultFrom ?? null,
    })
    .returning();
  if (!row) throw new Error("contact_books insert returned no row");
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contactBooks.create",
    targetType: "contactBook",
    targetId: id,
    diff: { name: { to: p.data.name } },
  });
  return { ok: true, data: { ...row, contactCount: 0, subscribedCount: 0 } };
}

export async function updateBook(
  actor: TeamActor,
  bookId: string,
  raw: unknown,
): Promise<Result<ContactBook>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = UpdateContactBookInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const [row] = await db()
    .update(contactBooks)
    .set({
      ...(p.data.name !== undefined && { name: p.data.name }),
      ...(p.data.defaultFrom !== undefined && {
        defaultFrom: p.data.defaultFrom,
      }),
      updatedAt: new Date(),
    })
    .where(
      and(eq(contactBooks.id, bookId), eq(contactBooks.teamId, actor.teamId)),
    )
    .returning();
  if (!row) return NO_BOOK;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contactBooks.update",
    targetType: "contactBook",
    targetId: bookId,
    diff: { name: { to: row.name } },
  });
  return { ok: true, data: row };
}

/**
 * Deleting a book cascades every contact in it away in one statement and
 * there is no history to restore from — so unlike the other contact
 * mutations it needs `settings.manage` (the same reasoning that makes
 * removing a suppression admin-only).
 */
export async function deleteBook(
  actor: TeamActor,
  bookId: string,
): Promise<Result> {
  if (!can(actor.role, "settings.manage")) return DENIED;
  const [row] = await db()
    .delete(contactBooks)
    .where(
      and(eq(contactBooks.id, bookId), eq(contactBooks.teamId, actor.teamId)),
    )
    .returning({ id: contactBooks.id, name: contactBooks.name });
  if (!row) return NO_BOOK;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contactBooks.delete",
    targetType: "contactBook",
    targetId: bookId,
    diff: { name: { from: row.name } },
  });
  return { ok: true, data: undefined };
}

/** Dates as ISO strings: a webhook payload is JSON, not a row. */
const publicContactAsJson = (c: Contact): Record<string, unknown> => {
  const v = publicContact(c);
  return {
    ...v,
    unsubscribedAt: v.unsubscribedAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
};

/**
 * Best-effort `contact.*` fan-out. Never throws and never blocks the mutation
 * it describes — the same contract `recordAudit` has. The **import** path
 * deliberately does not call this per row: 10 000 deliveries into a customer's
 * endpoint from one button is an outage we caused.
 */
async function emitContact(
  teamId: string,
  type: Extract<WebhookEventType, `contact.${string}`>,
  contact: Contact,
  deps: ContactDeps,
): Promise<void> {
  try {
    await fanOutEvent(
      teamId,
      type,
      newId("evt"),
      // `{ contact: … }`, not the fields at the top of `data`: every other
      // event names its object (`data.email`, `data.domain`), and a payload
      // that disagreed would force a subscriber to special-case contacts.
      { contact: publicContactAsJson(contact) },
      {
        enqueue: deps.enqueue,
        createdAt: deps.now,
      },
    );
  } catch (e) {
    console.error("[contacts] webhook fan-out failed", (e as Error).message);
  }
}

/**
 * `%` and `_` in a search term are the customer's characters, not wildcards:
 * a `q` of `%` must not quietly mean "every contact in the book".
 */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

/** REST page of one book's contacts, newest first, with search and a subscription filter. */
export async function listContactsPage(
  teamId: string,
  bookId: string,
  q: ListContactsQuery,
): Promise<Result<Page<Contact>>> {
  const where: SQL[] = [
    eq(contacts.teamId, teamId),
    eq(contacts.bookId, bookId),
  ];
  if (q.subscribed !== undefined)
    where.push(eq(contacts.subscribed, q.subscribed));
  if (q.q) {
    const term = escapeLike(q.q.toLowerCase());
    const match = or(
      ilike(contacts.email, `${term}%`),
      ilike(contacts.firstName, `%${term}%`),
      ilike(contacts.lastName, `%${term}%`),
    );
    if (match) where.push(match);
  }
  return keysetPage(contacts, q, and(...where));
}

export async function getContact(
  teamId: string,
  bookId: string,
  id: string,
): Promise<Contact | null> {
  const [row] = await db()
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.teamId, teamId),
        eq(contacts.bookId, bookId),
        eq(contacts.id, id),
      ),
    );
  return row ?? null;
}

export async function createContact(
  actor: TeamActor,
  bookId: string,
  raw: unknown,
  deps: ContactDeps,
): Promise<Result<Contact>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = CreateContactInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  // The book is looked up by (team, id) first, so `teamId` below is always the
  // book's owner: the denormalised column cannot drift from the book.
  if (!(await getBook(actor.teamId, bookId))) return NO_BOOK;
  const [row] = await db()
    .insert(contacts)
    .values({
      id: newId("ct"),
      bookId,
      teamId: actor.teamId,
      email: normaliseEmail(p.data.email),
      firstName: p.data.firstName ?? null,
      lastName: p.data.lastName ?? null,
      properties: p.data.properties,
      subscribed: p.data.subscribed,
      unsubscribedAt: p.data.subscribed ? null : (deps.now ?? new Date()),
    })
    .onConflictDoNothing(BOOK_UNIQUE)
    .returning();
  if (!row)
    return {
      ok: false,
      code: "conflict",
      error: "That address is already in this book.",
    };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contacts.create",
    targetType: "contact",
    targetId: row.id,
    diff: { email: { to: row.email }, bookId: { to: bookId } },
  });
  await emitContact(actor.teamId, "contact.created", row, deps);
  return { ok: true, data: row };
}

export async function updateContact(
  actor: TeamActor,
  bookId: string,
  id: string,
  raw: unknown,
  deps: ContactDeps,
): Promise<Result<Contact>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = UpdateContactInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const current = await getContact(actor.teamId, bookId, id);
  if (!current) return NO_CONTACT;
  const now = deps.now ?? new Date();
  const subscribed = p.data.subscribed ?? current.subscribed;
  const [row] = await db()
    .update(contacts)
    .set({
      ...(p.data.firstName !== undefined && { firstName: p.data.firstName }),
      ...(p.data.lastName !== undefined && { lastName: p.data.lastName }),
      ...(p.data.properties !== undefined && { properties: p.data.properties }),
      subscribed,
      // Coming back in clears the record of going out; going out stamps it.
      unsubscribedAt: subscribed ? null : (current.unsubscribedAt ?? now),
      unsubscribeReason: subscribed
        ? null
        : (p.data.unsubscribeReason ?? current.unsubscribeReason ?? "manual"),
      updatedAt: now,
    })
    // Scoped, not just by id: the read above authorised this row, and the
    // write repeats the scope so the two cannot disagree.
    .where(
      and(
        eq(contacts.id, id),
        eq(contacts.teamId, actor.teamId),
        eq(contacts.bookId, bookId),
      ),
    )
    .returning();
  if (!row) return NO_CONTACT;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contacts.update",
    targetType: "contact",
    targetId: id,
    diff: { subscribed: { from: current.subscribed, to: row.subscribed } },
  });
  if (current.subscribed !== row.subscribed)
    await emitContact(
      actor.teamId,
      row.subscribed ? "contact.resubscribed" : "contact.unsubscribed",
      row,
      deps,
    );
  else await emitContact(actor.teamId, "contact.updated", row, deps);
  return { ok: true, data: row };
}

export async function deleteContact(
  actor: TeamActor,
  bookId: string,
  id: string,
): Promise<Result> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const [row] = await db()
    .delete(contacts)
    .where(
      and(
        eq(contacts.teamId, actor.teamId),
        eq(contacts.bookId, bookId),
        eq(contacts.id, id),
      ),
    )
    .returning({ email: contacts.email });
  if (!row) return NO_CONTACT;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contacts.delete",
    targetType: "contact",
    targetId: id,
    diff: { email: { from: row.email } },
  });
  return { ok: true, data: undefined };
}

/**
 * Unsubscribes an address across **every book of the team** unless `bookId`
 * narrows it: the person said stop, not "stop for book A".
 *
 * It writes **no suppression row**. Suppression blocks every send to an
 * address, transactional included — a customer who leaves a newsletter must
 * still get their password reset. See `packages/shared/src/api/contacts.ts`.
 *
 * Idempotent: an address that is already out changes no rows and answers
 * `{ unsubscribed: 0 }`, because a link clicked twice is not an error.
 */
export async function unsubscribeContact(
  actor: TeamActor,
  raw: unknown,
  deps: ContactDeps,
): Promise<Result<UnsubscribeResult>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = UnsubscribeContactInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const now = deps.now ?? new Date();
  const email = normaliseEmail(p.data.email);
  const rows = await db()
    .update(contacts)
    .set({
      subscribed: false,
      unsubscribedAt: now,
      unsubscribeReason: p.data.reason ?? "api",
      updatedAt: now,
    })
    .where(
      and(
        eq(contacts.teamId, actor.teamId),
        eq(contacts.email, email),
        eq(contacts.subscribed, true),
        ...(p.data.bookId ? [eq(contacts.bookId, p.data.bookId)] : []),
      ),
    )
    .returning();
  if (rows.length) {
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      ...actor.meta,
      action: "contacts.unsubscribe",
      targetType: "contact",
      targetId: email,
      diff: { unsubscribed: { to: rows.length } },
    });
    for (const row of rows)
      await emitContact(actor.teamId, "contact.unsubscribed", row, deps);
  }
  return { ok: true, data: { unsubscribed: rows.length } };
}

/** Header aliases accepted for the known columns, case-insensitive. */
const EMAIL_HEADERS = new Set(["email", "email_address", "e-mail"]);
const FIRST_HEADERS = new Set(["first_name", "firstname", "first"]);
const LAST_HEADERS = new Set(["last_name", "lastname", "last"]);
const SUBSCRIBED_HEADERS = new Set(["subscribed"]);
const REASON_HEADERS = new Set(["unsubscribe_reason", "unsubscribereason"]);
/**
 * Recognised so it does not become a property, then ignored: when a row was
 * created is ours to assign, not the file's to set.
 */
const IGNORED_HEADERS = new Set(["created_at", "createdat"]);

/**
 * Every header the import reads as a *field*. The rule for everything else is
 * unchanged — it becomes a property — but this list is now load-bearing rather
 * than incidental: without it, re-importing this product's own export turns
 * `subscribed`, `unsubscribe_reason` and `created_at` into three junk
 * properties, and for a contact already at the 20-property cap it fails every
 * row. Export → edit in a spreadsheet → re-import is the most common thing
 * anyone does with a contact list, so it has to round-trip clean.
 */
const RESERVED_HEADERS = new Set([
  ...EMAIL_HEADERS,
  ...FIRST_HEADERS,
  ...LAST_HEADERS,
  ...SUBSCRIBED_HEADERS,
  ...REASON_HEADERS,
  ...IGNORED_HEADERS,
]);

/** `UpdateContactInput.unsubscribeReason`'s bound, applied at the other door. */
const MAX_REASON_CHARS = 200;

const SUBSCRIBED_FALSE = new Set([
  "false",
  "0",
  "no",
  "n",
  "f",
  "off",
  "unsubscribed",
]);
const SUBSCRIBED_TRUE = new Set([
  "true",
  "1",
  "yes",
  "y",
  "t",
  "on",
  "subscribed",
]);

/**
 * A `subscribed` cell → consent, or `null` when the value means nothing we
 * recognise.
 *
 * An absent column and a blank cell both mean "subscribed": a list without the
 * column is a list of people to mail, and reading a blank as "opted out" would
 * silently empty a customer's audience over a sloppy spreadsheet edit. An
 * unrecognised value is a **refusal for that row**, not a default — defaulting
 * it to `true` is precisely the silent resubscribe this column exists to stop.
 */
function parseSubscribed(cell: string): boolean | null {
  if (!cell) return true;
  const v = cell.toLowerCase();
  if (SUBSCRIBED_FALSE.has(v)) return false;
  if (SUBSCRIBED_TRUE.has(v)) return true;
  return null;
}

/** A row the import did not apply, with the physical line it was on. */
type ImportError = ImportContactsResult["errors"][number];

/**
 * The first `MAX_IMPORT_ERRORS - 1` problems in line order, plus one entry
 * saying how many were left out.
 *
 * `ImportContactsResult.errors` caps the array at 100. That cap is a
 * *response* validator, so returning 4 000 entries would turn a large bad file
 * into a serialisation failure instead of the report the customer needs — the
 * truncation has to happen here. Dropping the tail silently is the other half
 * of the trap: the count is what tells a customer their file has more wrong
 * with it than the list shows.
 */
function truncateErrors(all: ImportError[]): ImportError[] {
  const sorted = [...all].sort((a, b) => a.line - b.line);
  if (sorted.length <= MAX_IMPORT_ERRORS) return sorted;
  const kept = sorted.slice(0, MAX_IMPORT_ERRORS - 1);
  const omitted = sorted.length - kept.length;
  return [
    ...kept,
    {
      line: sorted[kept.length]!.line,
      email: null,
      reason: `${omitted} more rows had problems and are not listed here; fix these, then import the file again to see the rest.`,
    },
  ];
}

/**
 * CSV → contacts, upserted into one book.
 *
 * Buffered rather than streamed: the input is capped at 2 MB by
 * `ImportContactsInput`, which is smaller than one permitted attachment, and
 * the JSON envelope is buffered by `req.json()` regardless.
 *
 * Duplicates **inside one file** are collapsed keeping the last occurrence,
 * and not only for tidiness: Postgres refuses `ON CONFLICT DO UPDATE` when a
 * single statement touches the same key twice, so an un-deduped chunk is a
 * hard error the first time a customer uploads a real export.
 *
 * A bad row is counted and reported; only a structurally broken document is
 * fatal, because after an unterminated quote nothing that follows can be read.
 * That includes the rows `parseCsv` itself held back (ragged rows, over-long
 * cells) — they are merged into the same report rather than vanishing.
 *
 * Consent travels in one direction only. A **new** row takes the consent the
 * file gives it: `subscribed` is honoured when the column is present (a list
 * exported from another provider routinely carries people who opted out, and
 * importing them as subscribed is a consent failure that surfaces as a spam
 * complaint rather than a bug report), and defaults to subscribed only when
 * the column is absent. An **existing** row keeps the consent it already had:
 * the upsert's `set` clause never touches `subscribed`, `unsubscribed_at` or
 * `unsubscribe_reason`, so no file can resubscribe someone who opted out.
 */
export async function importContacts(
  actor: TeamActor,
  bookId: string,
  raw: unknown,
  deps: ContactDeps,
): Promise<Result<ImportContactsResult>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = ImportContactsInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  // As in `createContact`: the book is resolved by (team, id), so the
  // denormalised `teamId` written below is always the book's own team.
  if (!(await getBook(actor.teamId, bookId))) return NO_BOOK;
  const parsed = parseCsv(p.data.csv);
  if (!parsed.ok)
    return { ok: false, code: "validation_error", error: parsed.error };

  const header = parsed.data.header.map((h) => h.trim());
  const lower = header.map((h) => h.toLowerCase());
  const emailAt = lower.findIndex((h) => EMAIL_HEADERS.has(h));
  if (emailAt < 0)
    return {
      ok: false,
      code: "validation_error",
      error: 'The CSV needs an "email" column.',
      details: { header },
    };
  const firstAt = lower.findIndex((h) => FIRST_HEADERS.has(h));
  const lastAt = lower.findIndex((h) => LAST_HEADERS.has(h));
  const subscribedAt = lower.findIndex((h) => SUBSCRIBED_HEADERS.has(h));
  const reasonAt = lower.findIndex((h) => REASON_HEADERS.has(h));
  const propertyAt = header
    .map((name, i) => ({ name, i }))
    .filter((c) => c.name && !RESERVED_HEADERS.has(lower[c.i] ?? ""));

  // Every problem, not just the reported ones: `skipped` counts them all.
  // The parser's own held-back rows come first and carry no address, because
  // a ragged row's columns no longer line up with the header.
  const problems: ImportError[] = parsed.data.errors.map((e) => ({
    line: e.line,
    email: null,
    reason: e.reason,
  }));
  const byEmail = new Map<string, typeof contacts.$inferInsert>();
  let duplicates = 0;
  const now = deps.now ?? new Date();

  for (const row of parsed.data.rows) {
    const cell = (i: number) => (i < 0 ? "" : (row.cells[i] ?? "").trim());
    const rawEmail = cell(emailAt);
    // Consent first: a row whose `subscribed` cell is unreadable is held back
    // rather than imported as subscribed.
    const subscribed = parseSubscribed(cell(subscribedAt));
    if (subscribed === null) {
      problems.push({
        line: row.line,
        email: rawEmail || null,
        reason: `Value in column "${header[subscribedAt] ?? "subscribed"}" must be true or false.`,
      });
      continue;
    }
    const reason = cell(reasonAt);
    if (reason.length > MAX_REASON_CHARS) {
      problems.push({
        line: row.line,
        email: rawEmail || null,
        reason: `Value in column "${header[reasonAt] ?? "unsubscribe_reason"}" is longer than ${MAX_REASON_CHARS} characters.`,
      });
      continue;
    }
    const parsedContact = CreateContactInput.safeParse({
      email: rawEmail,
      firstName: cell(firstAt) || undefined,
      lastName: cell(lastAt) || undefined,
      subscribed,
      // A blank cell is an absent property, not an empty one: the renderer
      // treats `""` as missing, so storing it would only hide the gap.
      properties: Object.fromEntries(
        propertyAt
          .map((c) => [c.name, cell(c.i)] as const)
          .filter(([, v]) => v !== ""),
      ),
    });
    if (!parsedContact.success) {
      problems.push({
        line: row.line,
        email: rawEmail || null,
        reason: parsedContact.error.issues[0]?.message ?? "Invalid row.",
      });
      continue;
    }
    const email = normaliseEmail(parsedContact.data.email);
    if (byEmail.has(email)) duplicates++;
    byEmail.set(email, {
      id: newId("ct"),
      bookId,
      teamId: actor.teamId,
      email,
      firstName: parsedContact.data.firstName ?? null,
      lastName: parsedContact.data.lastName ?? null,
      properties: parsedContact.data.properties,
      subscribed: parsedContact.data.subscribed,
      unsubscribedAt: parsedContact.data.subscribed ? null : now,
      unsubscribeReason: parsedContact.data.subscribed
        ? null
        : reason || "import",
      updatedAt: now,
    });
  }

  const candidates = [...byEmail.values()];
  // Which addresses are already in the book, so inserts and updates can be
  // reported separately (and so `updateExisting: false` can leave them alone).
  const existing = new Set<string>();
  for (let i = 0; i < candidates.length; i += IMPORT_CHUNK) {
    const chunk = candidates.slice(i, i + IMPORT_CHUNK).map((c) => c.email);
    const rows = await db()
      .select({ email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.bookId, bookId), inArray(contacts.email, chunk)));
    for (const r of rows) existing.add(r.email);
  }

  const toInsert = candidates.filter((c) => !existing.has(c.email));
  const toUpdate = p.data.updateExisting
    ? candidates.filter((c) => existing.has(c.email))
    : [];
  const skipped =
    problems.length +
    (p.data.updateExisting ? 0 : candidates.length - toInsert.length);

  for (const batch of [toInsert, toUpdate]) {
    for (let i = 0; i < batch.length; i += IMPORT_CHUNK) {
      const chunk = batch.slice(i, i + IMPORT_CHUNK);
      if (!chunk.length) continue;
      await db()
        .insert(contacts)
        .values(chunk)
        // `$onUpdate` does not fire on a conflict path, so `updatedAt` is set
        // explicitly here and in the values above. `subscribed` is absent from
        // the set on purpose: an import must not resubscribe anyone.
        .onConflictDoUpdate({
          target: [contacts.bookId, contacts.email],
          set: {
            firstName: sql`excluded.first_name`,
            lastName: sql`excluded.last_name`,
            properties: sql`excluded.properties`,
            updatedAt: now,
          },
        });
    }
  }

  const data: ImportContactsResult = {
    imported: toInsert.length,
    updated: toUpdate.length,
    skipped,
    duplicates,
    errors: truncateErrors(problems),
  };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contacts.import",
    targetType: "contactBook",
    targetId: bookId,
    diff: {
      imported: { to: data.imported },
      updated: { to: data.updated },
      skipped: { to: data.skipped },
    },
  });
  // No per-contact webhook here on purpose: 10 000 deliveries into a
  // customer's endpoint from one button is an outage we caused. A summary
  // `contacts.imported` event is a Phase 7 opener.
  return { ok: true, data };
}
