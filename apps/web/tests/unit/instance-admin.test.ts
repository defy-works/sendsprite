import { describe, expect, it } from "vitest";
import { isInstanceAdmin, parseAdminEmails } from "@/lib/instance-admin";

describe("parseAdminEmails", () => {
  it("splits, trims and lowercases", () => {
    expect(parseAdminEmails(" A@x.com , b@Y.com ")).toEqual([
      "a@x.com",
      "b@y.com",
    ]);
  });
  it("drops empty entries", () => {
    expect(parseAdminEmails("a@x.com,,  ,b@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
  });
  it("returns an empty list for undefined or blank", () => {
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails("   ")).toEqual([]);
  });
});

describe("isInstanceAdmin", () => {
  it("passes an env-listed email regardless of the flag", () => {
    expect(
      isInstanceAdmin({ email: "A@x.com", flag: false }, ["a@x.com"]),
    ).toBe(true);
  });
  it("passes a flagged user with an empty env list", () => {
    expect(isInstanceAdmin({ email: "z@x.com", flag: true }, [])).toBe(true);
  });
  it("refuses an unflagged, unlisted user", () => {
    expect(
      isInstanceAdmin({ email: "z@x.com", flag: false }, ["a@x.com"]),
    ).toBe(false);
  });
});
