import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "@/lib/canonical-json";
import { startPg, type TestPg } from "./_pg";

/**
 * The premise behind `canonicalJson`, asserted against a real database rather
 * than argued from the docs.
 *
 * `services/templates.ts` carried a comment claiming that two values which had
 * been through the same zod object would serialise identically. They do not,
 * once one of them has been stored in a `jsonb` column: Postgres sorts object
 * keys by length and then bytewise. The consequence there was a version row
 * cut on a save that changed nothing; in `services/campaigns/crud.ts` it would
 * have been worse, because an "edit" reverts a scheduled campaign to a draft —
 * so re-saving an unchanged body would silently cancel the schedule.
 */
let pg: TestPg;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

describe("jsonb key order", () => {
  it("does not survive a round trip through jsonb", async () => {
    const value = { kind: "text", html: "x", alpha: 1 };
    const res = await pg.db.execute(
      `select '${JSON.stringify(value)}'::jsonb as j`,
    );
    const row = (
      Array.isArray(res) ? res[0] : (res as { rows: unknown[] }).rows[0]
    ) as {
      j: Record<string, unknown>;
    };

    // The order written is not the order read back.
    expect(Object.keys(value)).toEqual(["kind", "html", "alpha"]);
    expect(Object.keys(row.j)).not.toEqual(["kind", "html", "alpha"]);

    // Which is exactly why a plain stringify comparison reports a change...
    expect(JSON.stringify(row.j)).not.toBe(JSON.stringify(value));
    // ...and why the canonical one does not.
    expect(canonicalJson(row.j)).toBe(canonicalJson(value));
  });

  it("keeps array order, because in an array the order is the value", () => {
    expect(canonicalJson([{ b: 1, a: 2 }, "x"])).toBe('[{"a":2,"b":1},"x"]');
    expect(canonicalJson(["a", "b"])).not.toBe(canonicalJson(["b", "a"]));
  });

  it("sorts nested keys at every depth", () => {
    expect(canonicalJson({ z: { d: 1, c: 2 }, a: 3 })).toBe(
      '{"a":3,"z":{"c":2,"d":1}}',
    );
  });

  it("treats undefined and null alike, so an absent field is not a change", () => {
    expect(canonicalJson(undefined)).toBe(canonicalJson(null));
  });
});
