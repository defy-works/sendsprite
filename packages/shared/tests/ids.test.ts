import { describe, expect, it } from "vitest";
import { newId, parseId, ID_PREFIXES } from "../src/ids";

describe("newId", () => {
  it("prefixes with the entity tag and an underscore", () => {
    const id = newId("em");
    expect(id.startsWith("em_")).toBe(true);
    expect(id.length).toBe(3 + 26); // ULID is 26 chars
  });
  it("is unique across calls", () => {
    const a = newId("dom");
    const b = newId("dom");
    expect(a).not.toBe(b);
  });
  it("parseId returns prefix and ulid, rejects unknown prefixes", () => {
    const id = newId("key");
    expect(parseId(id)).toEqual({ prefix: "key", ulid: id.slice(4) });
    expect(parseId("zzz_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBeNull();
    expect(parseId("garbage")).toBeNull();
  });
  it("exposes every prefix we plan to use", () => {
    expect(ID_PREFIXES).toContain("em");
    expect(ID_PREFIXES).toContain("evt");
  });
});
