import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { contacts, type Contact } from "@/db/schema";
import { csvLine } from "@/lib/csv";
import { requireTeam } from "@/lib/session";
import { getBook } from "@/services/contacts";
import {
  exportFilename,
  exportRow,
  exportShape,
  MAX_PROPERTY_COLUMNS,
  type ExportShape,
} from "../../export-csv";

export const dynamic = "force-dynamic";

/** Rows held in memory at once. One statement per batch, keyset-paged. */
const BATCH = 500;

/**
 * The whole book as CSV. Session-authenticated (this lives under `/app`, not
 * `/api/v1`), so it is not part of the OpenAPI surface.
 *
 * ## Authorisation
 *
 * `requireTeam()` plus a team-scoped `getBook`, and deliberately no `can()`
 * check on top. Reading is team-wide everywhere else in this dashboard —
 * templates, suppressions and the contact table this exports all render for
 * any member — so gating the download would only mean a member could read
 * every row on screen and not save the same rows to a file. Every mutation
 * still goes through the service's own checks.
 *
 * ## Memory
 *
 * Streamed in keyset-paged batches rather than selected in one go and joined
 * into a string. A book has no size limit of its own: the import caps a
 * *file* at 10 000 rows, not a book at anything, and a customer who imports
 * fifty files has half a million contacts. Buffering that would be two full
 * copies (rows and text) on the heap of a server that is also rendering
 * pages, so the request that finally does it takes the whole instance down
 * rather than being slow. Nothing is truncated — the alternative was a hard
 * row cap, and a silently short export that looks complete is exactly the
 * file somebody re-imports as their "full" list somewhere else.
 *
 * ## Escaping
 *
 * Every cell goes through `csvLine` → `csvCell`, which prefixes a value
 * starting `=`, `+`, `-`, `@`, tab or CR with a `'`. A contact whose "first
 * name" is `=HYPERLINK(...)` must not become a live formula the moment
 * somebody opens the file in Excel. `tests/unit/contacts-export.test.ts`
 * covers that, and `tests/e2e/contacts.spec.ts` downloads a real export and
 * checks the escaped cell came back.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ bookId: string }> },
): Promise<Response> {
  const { bookId } = await ctx.params;
  const team = await requireTeam();
  const book = await getBook(team.team.id, bookId);
  if (!book) return new Response("Not found", { status: 404 });

  const shape = exportShape(await propertyKeys(team.team.id, bookId));
  return new Response(stream(lines(team.team.id, bookId, shape)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${exportFilename(book.name)}"`,
      "cache-control": "no-store, private",
    },
  });
}

/**
 * The distinct property keys used anywhere in the book, in the order the
 * rows will be written (newest contact first).
 *
 * A separate query rather than a union accumulated while streaming, because
 * the header has to be written before the first row and the keys are not
 * known until the last one. One `limit`ed aggregate is cheap next to the
 * scan that follows, and asking for one key more than can fit is what lets
 * `exportShape` tell "exactly full" from "overflowing".
 */
async function propertyKeys(teamId: string, bookId: string): Promise<string[]> {
  const rows = await db().execute(
    sql`select key from (
          select jsonb_object_keys(${contacts.properties}) as key,
                 ${contacts.createdAt} as created_at
            from ${contacts}
           where ${contacts.teamId} = ${teamId}
             and ${contacts.bookId} = ${bookId}
        ) k
        group by key
        order by max(created_at) desc, key asc
        limit ${MAX_PROPERTY_COLUMNS + 1}`,
  );
  return [...rows].map((r) => String((r as { key: string }).key));
}

/** The header, then every contact, a batch of text at a time. */
async function* lines(
  teamId: string,
  bookId: string,
  shape: ExportShape,
): AsyncGenerator<string> {
  yield csvLine(shape.header);
  let cursor: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const batch: Contact[] = await db()
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.teamId, teamId),
          eq(contacts.bookId, bookId),
          // The same `(created_at, id)` keyset the dashboard's own list pages
          // on (`db/keyset.ts`), so an export reads the book in the order the
          // table shows it.
          cursor
            ? sql`(${contacts.createdAt}, ${contacts.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id})`
            : undefined,
        ),
      )
      .orderBy(desc(contacts.createdAt), desc(contacts.id))
      .limit(BATCH);
    if (!batch.length) return;
    yield batch.map((c) => csvLine(exportRow(c, shape))).join("");
    if (batch.length < BATCH) return;
    const last = batch[batch.length - 1] as Contact;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
}

/**
 * Text chunks → a response body. Pull-driven, so the next batch is only
 * queried once the client has taken the previous one, and a client that
 * disconnects stops the scan instead of paying for the rest of it.
 */
function stream(chunks: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    cancel: (reason) => void chunks.return(reason),
  });
}
