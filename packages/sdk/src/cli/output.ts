/** Dependency-free terminal formatting for the CLI. */

/**
 * Left-aligned columns padded to the widest cell, joined by two spaces. The
 * last column is never padded so lines have no trailing whitespace.
 */
export function table(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return [];
  const columns = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(...rows.map((r) => width(cell(r, i)))),
  );
  return rows.map((row) =>
    Array.from({ length: columns }, (_, i) => cell(row, i))
      .map((text, i) => (i === columns - 1 ? text : pad(text, widths[i]!)))
      .join("  ")
      .trimEnd(),
  );
}

const cell = (row: readonly string[], i: number) => row[i] ?? "";

/**
 * Code points, not UTF-16 units: `.length` counts an emoji or an astral
 * character twice and pads that column short, so an internationalised domain
 * knocks the whole table out of alignment. (Still not East-Asian display
 * width — that needs a table this package will not carry.)
 */
const width = (text: string) => [...text].length;

const pad = (text: string, to: number) => text + " ".repeat(to - width(text));

/** `Team  Acme (t)` — a label padded to a common width, then a value. */
export const field = (label: string, value: string): string =>
  `${label.padEnd(6)}${value}`;

/** Human message for anything thrown, without leaking a stack trace. */
export const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
