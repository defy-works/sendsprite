import { describe, expect, it } from "vitest";
import {
  parseAddress,
  normaliseEmail,
  domainOf,
  formatAddress,
} from "@/lib/email-address";

describe("parseAddress", () => {
  it("parses name-addr and addr-spec", () => {
    expect(parseAddress("Acme Team <Hello@Mail.Acme.com>")).toEqual({
      name: "Acme Team",
      email: "hello@mail.acme.com",
      raw: "Acme Team <Hello@Mail.Acme.com>",
    });
    expect(parseAddress("a@b.com")).toEqual({
      name: null,
      email: "a@b.com",
      raw: "a@b.com",
    });
    expect(parseAddress('"Smith, J" <j@x.io>')?.name).toBe("Smith, J");
    expect(parseAddress("<a@b.com>")).toMatchObject({
      name: null,
      email: "a@b.com",
    });
  });
  it("returns null for junk", () => {
    expect(parseAddress("nope")).toBeNull();
    expect(parseAddress("<>")).toBeNull();
    expect(parseAddress("Name <not-an-email>")).toBeNull();
    expect(parseAddress("")).toBeNull();
  });
  it("domainOf and normaliseEmail", () => {
    expect(domainOf("x@Mail.Acme.com")).toBe("mail.acme.com");
    expect(normaliseEmail(" A@B.COM ")).toBe("a@b.com");
  });
  it("formatAddress quotes display names", () => {
    expect(formatAddress({ name: 'Q "x"', email: "a@b.com" })).toBe(
      '"Q \\"x\\"" <a@b.com>',
    );
    expect(formatAddress({ name: null, email: "a@b.com" })).toBe("a@b.com");
    expect(formatAddress({ name: "a\\b", email: "a@b.com" })).toBe(
      '"a\\\\b" <a@b.com>',
    );
  });
});
