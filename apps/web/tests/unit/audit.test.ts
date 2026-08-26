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
  it("redacts keys containing enc, secret, token, password, hash or key", () => {
    for (const key of [
      "awsSecretEnc",
      "token",
      "keyHash",
      "passwordHash",
      "awsAccessKeyId",
    ]) {
      expect(computeDiff({ [key]: "1" }, { [key]: "2" })).toEqual({
        [key]: { from: "[redacted]", to: "[redacted]" },
      });
    }
  });
  it("does not redact plain keys, but fails closed on substrings like tokenCount", () => {
    expect(
      computeDiff({ name: "A", slug: "a" }, { name: "B", slug: "b" }),
    ).toEqual({
      name: { from: "A", to: "B" },
      slug: { from: "a", to: "b" },
    });
    expect(computeDiff({ tokenCount: 1 }, { tokenCount: 2 })).toEqual({
      tokenCount: { from: "[redacted]", to: "[redacted]" },
    });
  });
});
