import { describe, expect, it } from "vitest";
import { checkRecords, type Resolver } from "@/lib/dns/check";
import { expectedRecords } from "@/lib/dns/records";

const resolver: Resolver = {
  resolveCname: async (n) =>
    n.startsWith("a1._domainkey") ? ["A1.dkim.amazonses.com."] : [],
  resolveMx: async (n) =>
    n === "bounce.mail.acme.com"
      ? [{ exchange: "feedback-smtp.eu-west-1.amazonses.com", priority: 20 }]
      : [],
  resolveTxt: async (n) =>
    n === "_dmarc.mail.acme.com"
      ? [["v=DMARC1;  p=none; rua=mailto:dmarc@mail.acme.com "]]
      : n === "bounce.mail.acme.com"
        ? [["v=spf1 -all"], ["v=spf1 ", "include:amazonses.com ~all"]]
        : [],
};

describe("checkRecords", () => {
  it("marks each expected record ok/not-ok from live DNS", async () => {
    const recs = expectedRecords({
      domain: "mail.acme.com",
      region: "eu-west-1",
      dkimTokens: ["a1", "b2", "c3"],
      mailFromDomain: "bounce.mail.acme.com",
    });
    const out = await checkRecords(recs, resolver);
    expect(out.map((r) => r.ok)).toEqual([
      true,
      false,
      false,
      true,
      true,
      true,
    ]);
    // Input is not mutated.
    expect(recs.every((r) => r.ok === false)).toBe(true);
  });
  it("treats resolver errors (NXDOMAIN) as not-ok", async () => {
    const throwing: Resolver = {
      resolveCname: async () => {
        throw Object.assign(new Error("x"), { code: "ENOTFOUND" });
      },
      resolveMx: async () => {
        throw new Error("x");
      },
      resolveTxt: async () => {
        throw new Error("x");
      },
    };
    const out = await checkRecords(
      expectedRecords({
        domain: "a.com",
        region: "us-east-1",
        dkimTokens: ["t"],
        mailFromDomain: "b.a.com",
      }),
      throwing,
    );
    expect(out).toHaveLength(4);
    expect(out.every((r) => r.ok === false)).toBe(true);
  });
});
