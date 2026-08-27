import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
  it("accepts same-origin paths", () => {
    expect(safeNext("/app/x")).toBe("/app/x");
    expect(safeNext("/invite/abc?x=1")).toBe("/invite/abc?x=1");
  });
  it.each([
    ["//evil.com"],
    ["/\\evil.com"],
    ["/%2fevil.com"],
    ["/%2Fevil.com"],
    ["/%5cevil.com"],
    ["https://x"],
    [""],
    [undefined],
    [42],
  ])("falls back for %p", (raw) => {
    expect(safeNext(raw)).toBe("/app");
    expect(safeNext(raw, "/x")).toBe("/x");
  });
});
