import { describe, expect, it } from "vitest";
import {
  exportFilename,
  exportRow,
  exportShape,
  FIXED_COLUMNS,
  MAX_PROPERTY_COLUMNS,
  OVERFLOW_COLUMN,
  type ExportableContact,
} from "@/app/app/contacts/export-csv";
import { MAX_CSV_COLUMNS, csvLine, parseCsv, toCsv } from "@/lib/csv";

const contact = (over: Partial<ExportableContact> = {}): ExportableContact => ({
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  properties: {},
  subscribed: true,
  unsubscribeReason: null,
  createdAt: new Date("2026-08-26T10:40:00.000Z"),
  ...over,
});

describe("exportShape", () => {
  it("puts the fixed columns first and the property keys in the order given", () => {
    const shape = exportShape(["plan", "city"]);
    expect(shape.header).toEqual([...FIXED_COLUMNS, "plan", "city"]);
    expect(shape.overflow).toBe(false);
  });

  it("ignores a repeated key rather than emitting the column twice", () => {
    expect(exportShape(["plan", "plan"]).header).toEqual([
      ...FIXED_COLUMNS,
      "plan",
    ]);
  });

  it("fills every property column it has before it overflows", () => {
    const keys = Array.from(
      { length: MAX_PROPERTY_COLUMNS },
      (_, i) => `k${i}`,
    );
    const shape = exportShape(keys);
    expect(shape.overflow).toBe(false);
    expect(shape.keys).toEqual(keys);
    expect(shape.header).toHaveLength(MAX_CSV_COLUMNS);
  });

  it("keeps the document within the width parseCsv accepts when keys overflow", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
    const shape = exportShape(keys);
    expect(shape.overflow).toBe(true);
    expect(shape.keys).toHaveLength(MAX_PROPERTY_COLUMNS - 1);
    expect(shape.header).toHaveLength(MAX_CSV_COLUMNS);
    expect(shape.header.at(-1)).toBe(OVERFLOW_COLUMN);
  });
});

describe("exportRow", () => {
  it("writes the fixed fields, with nulls as empty cells", () => {
    const shape = exportShape([]);
    expect(
      exportRow(
        contact({ firstName: null, lastName: null, subscribed: false }),
        shape,
      ),
    ).toEqual([
      "ada@example.com",
      "",
      "",
      "false",
      "",
      "2026-08-26T10:40:00.000Z",
    ]);
  });

  it("carries the unsubscribe reason so an export round-trips consent", () => {
    const shape = exportShape([]);
    const row = exportRow(
      contact({ subscribed: false, unsubscribeReason: "api" }),
      shape,
    );
    expect(row[3]).toBe("false");
    expect(row[4]).toBe("api");
  });

  it("is always header-width, so a missing property does not shift a row", () => {
    const shape = exportShape(["plan", "city"]);
    const row = exportRow(contact({ properties: { city: "London" } }), shape);
    expect(row).toHaveLength(shape.header.length);
    expect(row.at(-2)).toBe("");
    expect(row.at(-1)).toBe("London");
  });

  it("puts the keys that did not get a column into properties_json", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
    const shape = exportShape(keys);
    const properties = Object.fromEntries(
      ["k0", "k30", "k31"].map((k) => [k, `v-${k}`]),
    );
    const row = exportRow(contact({ properties }), shape);
    expect(row).toHaveLength(MAX_CSV_COLUMNS);
    expect(row[FIXED_COLUMNS.length]).toBe("v-k0");
    expect(JSON.parse(row.at(-1) as string)).toEqual({
      k30: "v-k30",
      k31: "v-k31",
    });
  });

  it("leaves properties_json empty when a contact has nothing left over", () => {
    const shape = exportShape(Array.from({ length: 200 }, (_, i) => `k${i}`));
    expect(exportRow(contact({ properties: { k0: "x" } }), shape).at(-1)).toBe(
      "",
    );
  });
});

/**
 * The security-relevant behaviour of this route, and the reason it exists as
 * a testable module: a contact's name is attacker-supplied (anyone who can
 * sign up to a customer's newsletter can choose it), and the export is a file
 * an operator opens in Excel.
 */
describe("formula injection", () => {
  const shape = exportShape(["plan"]);

  it("neutralises a formula in a name so a spreadsheet shows it as text", () => {
    const row = exportRow(
      contact({ firstName: '=HYPERLINK("http://evil.test")' }),
      shape,
    );
    // The raw cell is untouched; the escaping belongs to csvCell.
    expect(row[1]).toBe('=HYPERLINK("http://evil.test")');
    expect(csvLine(row)).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
  });

  it("guards every leader a spreadsheet would evaluate, in any column", () => {
    const row = exportRow(
      contact({
        firstName: "+1 (555) 0100",
        lastName: "-1234",
        properties: { plan: "@SUM(A1)" },
      }),
      shape,
    );
    const line = csvLine(row);
    expect(line).toContain("'+1 (555) 0100");
    expect(line).toContain("'-1234");
    expect(line).toContain("'@SUM(A1)");
  });

  it("round-trips through parseCsv: what was exported is what re-imports", () => {
    const rows = [
      contact({ firstName: '=HYPERLINK("http://evil.test")' }),
      contact({ email: "grace@example.com", firstName: "-1234" }),
    ].map((c) => exportRow(c, shape));
    const parsed = parseCsv(toCsv(shape.header, rows));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.header).toEqual(shape.header);
    expect(parsed.data.rows.map((r) => r.cells)).toEqual(rows);
  });
});

describe("exportFilename", () => {
  it("slugs the book name", () => {
    expect(exportFilename("Newsletter")).toBe("newsletter-contacts.csv");
    expect(exportFilename("Q3 launch — EU")).toBe("q3-launch-eu-contacts.csv");
  });

  it("cannot smuggle anything into the content-disposition header", () => {
    const name = exportFilename('"; filename="payload.exe\r\nX-Evil: 1');
    expect(name).toBe("filename-payload-exe-x-evil-1-contacts.csv");
    expect(name).not.toMatch(/["\r\n;]/);
  });

  it("falls back rather than producing a nameless attachment", () => {
    expect(exportFilename("顧客")).toBe("contacts-contacts.csv");
    expect(exportFilename("   ")).toBe("contacts-contacts.csv");
  });

  it("bounds the length", () => {
    expect(exportFilename(`${"a".repeat(58)} tail`)).toBe(
      `${"a".repeat(58)}-t-contacts.csv`,
    );
  });

  it("does not leave the dash the bound cut a word off at", () => {
    expect(exportFilename(`${"a".repeat(59)} tail`)).toBe(
      `${"a".repeat(59)}-contacts.csv`,
    );
  });
});
