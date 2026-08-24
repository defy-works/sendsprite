import { describe, expect, it } from "vitest";
import { computeDiff } from "@/lib/audit";

describe("computeDiff", () => {
  it("records only changed keys", () => {
    expect(
      computeDiff({ name: "A", slug: "a" }, { name: "B", slug: "a" }),
    ).toEqual({ name: { from: "A", to: "B" } });
  });
  it("returns null when nothing changed", () => {
    expect(computeDiff({ a: 1 }, { a: 1 })).toBeNull();
  });
  it("redacts keys ending in Enc, Secret or Token", () => {
    expect(computeDiff({ awsSecretEnc: "x" }, { awsSecretEnc: "y" })).toEqual({
      awsSecretEnc: { from: "[redacted]", to: "[redacted]" },
    });
    expect(computeDiff({ token: "1" }, { token: "2" })).toEqual({
      token: { from: "[redacted]", to: "[redacted]" },
    });
  });
});
