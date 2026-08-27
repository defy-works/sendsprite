import { MAX_CSV_COLUMNS } from "@/lib/csv";

/**
 * The pure half of the contact export: what its columns are, what one row
 * looks like, and what the file is called.
 *
 * It is a module rather than inline code in `[bookId]/export/route.ts` for
 * the reason `templates/preview.ts` is one — the behaviour worth testing here
 * is not "does a `Response` come back" but "does a cell a spreadsheet would
 * execute come back inert, and does a book with more property keys than the
 * format has columns lose anything". Neither needs a database, and the route
 * that does cannot be unit-tested in this repo.
 *
 * Escaping itself is not reimplemented here: cells go through `csvLine` →
 * `csvCell` in `@/lib/csv`, which prefixes a value starting `=`, `+`, `-`,
 * `@`, tab or CR with a `'` so Excel and Sheets treat it as text. That guard
 * is reversible, so a file this writes re-imports through `parseCsv`
 * unchanged. See `csvCell` for why the guard is an escape and not a rewrite.
 */

/** The columns every export has, in order, before any property columns. */
export const FIXED_COLUMNS = [
  "email",
  "first_name",
  "last_name",
  "subscribed",
  "unsubscribe_reason",
  "created_at",
] as const;

/**
 * Where property keys go once they no longer fit in their own columns: a JSON
 * object of everything left over, in the last column.
 *
 * A contact holds at most 20 properties, but a *book* can hold any number of
 * distinct keys — twenty contacts with twenty different keys each is 400
 * columns. `parseCsv` refuses a document wider than `MAX_CSV_COLUMNS`, so an
 * unbounded header is an export this product cannot re-import, and dropping
 * the overflow silently is worse: the file would look complete and would not
 * be. Folding the tail into one JSON cell keeps every value in the file, keeps
 * the width inside the import's own limit, and makes the loss of *shape*
 * visible in the header rather than invisible in the data.
 */
export const OVERFLOW_COLUMN = "properties_json";

/** Property columns an export may spend, before the overflow column. */
export const MAX_PROPERTY_COLUMNS = MAX_CSV_COLUMNS - FIXED_COLUMNS.length;

/** The fields the export reads. A `Contact` row satisfies it. */
export interface ExportableContact {
  email: string;
  firstName: string | null;
  lastName: string | null;
  properties: Record<string, string>;
  subscribed: boolean;
  unsubscribeReason: string | null;
  createdAt: Date;
}

export interface ExportShape {
  /** Property keys that get a column of their own, in header order. */
  keys: string[];
  /** Whether a trailing `properties_json` column carries the rest. */
  overflow: boolean;
  /** The full header row. */
  header: string[];
}

/**
 * The header for a book whose contacts, between them, use `distinctKeys`.
 *
 * The caller passes the keys in the order it wants them, and may pass more
 * than fit — it cannot know the budget, and asking it to would put this rule
 * in two places. When they do not fit, the last column becomes
 * `OVERFLOW_COLUMN` and `exportRow` puts everything without a column of its
 * own in there.
 */
export function exportShape(distinctKeys: readonly string[]): ExportShape {
  // A duplicate key would produce two columns holding the same value and
  // widen the header for nothing; the query that feeds this is a `group by`,
  // but the invariant belongs with the function that depends on it.
  const unique = [...new Set(distinctKeys)];
  const overflow = unique.length > MAX_PROPERTY_COLUMNS;
  const keys = overflow
    ? unique.slice(0, MAX_PROPERTY_COLUMNS - 1)
    : [...unique];
  return {
    keys,
    overflow,
    header: [...FIXED_COLUMNS, ...keys, ...(overflow ? [OVERFLOW_COLUMN] : [])],
  };
}

/**
 * One contact as cells, in `shape.header`'s order. Always full width, because
 * a short row would silently shift every value after the gap.
 *
 * Values are written raw: escaping happens once, in `csvLine`.
 */
export function exportRow(
  contact: ExportableContact,
  shape: ExportShape,
): string[] {
  const cells: string[] = [
    contact.email,
    contact.firstName ?? "",
    contact.lastName ?? "",
    String(contact.subscribed),
    contact.unsubscribeReason ?? "",
    contact.createdAt.toISOString(),
    ...shape.keys.map((k) => contact.properties[k] ?? ""),
  ];
  if (shape.overflow) {
    const rest = Object.fromEntries(
      Object.entries(contact.properties).filter(
        ([k]) => !shape.keys.includes(k),
      ),
    );
    cells.push(Object.keys(rest).length ? JSON.stringify(rest) : "");
  }
  return cells;
}

/** Bounds the filename; a book name is 120 characters and a slug of that is silly. */
const MAX_SLUG_CHARS = 60;

/**
 * `"<slug>-contacts.csv"`, derived from the book's name.
 *
 * Everything outside `[a-z0-9]` collapses to a dash, which is what keeps the
 * name out of the `content-disposition` header's grammar: a book called
 * `"; filename="payload.exe` cannot smuggle a quote, a semicolon or a newline
 * into the header, because none of those characters survive. A name with no
 * ASCII letters at all (`"顧客"`) slugs to nothing, hence the fallback — an
 * attachment called `-.csv` is not a filename anybody wants either.
 */
export function exportFilename(bookName: string): string {
  const slug = bookName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/-+$/, "");
  return `${slug || "contacts"}-contacts.csv`;
}
