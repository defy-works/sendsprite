/** Dependency-free terminal formatting for the CLI. */

/**
 * Left-aligned columns padded to the widest cell, joined by two spaces. The
 * last column is never padded so lines have no trailing whitespace.
 */
export function table(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return [];
  const columns = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, i) =>
    Math.max(...rows.map((r) => (r[i] ?? "").length)),
  );
  return rows.map((row) =>
    Array.from({ length: columns }, (_, i) => r(row, i))
      .map((cell, i) => (i === columns - 1 ? cell : cell.padEnd(widths[i]!)))
      .join("  ")
      .trimEnd(),
  );
}

const r = (row: readonly string[], i: number) => row[i] ?? "";

/** `Team  Acme (t)` — a label padded to a common width, then a value. */
export const field = (label: string, value: string): string =>
  `${label.padEnd(6)}${value}`;

/** Human message for anything thrown, without leaking a stack trace. */
export const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
