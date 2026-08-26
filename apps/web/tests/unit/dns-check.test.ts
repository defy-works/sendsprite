import { describe, expect, it } from "vitest";
import { checkRecords, type Resolver } from "@/lib/dns/check";
import { expectedRecords } from "@/lib/dns/records";

const resolver: Resolver = {
  resolveNs: async () => [],
  resolveCname: async (n) =>
    n.startsWith("a1._domainkey") ? ["A1.dkim.amazonses.com."] : [],
  resolveMx: async (n) =>
    n === "bounce.mail.acme.com"
      ? [{ exchange: "feedback-smtp.eu-west-1.amazonses.com", priority: 20 }]
      : [],
  resolveTxt: async (n) =>
    n === "_dmarc.mail.acme.com"
      ? [["v=DMARC1; p=quarantine; pct=25; rua=mailto:x@acme.com"]]
      : n === "bounce.mail.acme.com"
        ? [["v=spf1 include:_spf.google.com ", "include:amazonses.com ~all"]]
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
  it("SPF needs a v=spf1 record that includes amazonses.com; DMARC needs any v=DMARC1", async () => {
    const recs = expectedRecords({
      domain: "a.com",
      region: "us-east-1",
      dkimTokens: [],
      mailFromDomain: "b.a.com",
    });
    const withTxt = (txt: string[][]) =>
      checkRecords(recs, {
        resolveNs: async () => [],
        resolveCname: async () => [],
        resolveMx: async () => [],
        resolveTxt: async () => txt,
      }).then((out) => out.slice(1).map((r) => r.ok));
    // [SPF, DMARC]
    expect(await withTxt([["include:amazonses.com"]])).toEqual([false, false]);
    expect(await withTxt([["v=spf1 -all"]])).toEqual([false, false]);
    expect(await withTxt([['"V=SPF1 include:amazonses.com -all"']])).toEqual([
      true,
      false,
    ]);
    // Whole-token match: a look-alike suffix must not pass.
    expect(
      await withTxt([["v=spf1 include:amazonses.com.evil.net -all"]]),
    ).toEqual([false, false]);
    expect(await withTxt([["v=spf1 include:amazonses.com"]])).toEqual([
      true,
      false,
    ]);
    expect(await withTxt([["v=DMARC1; p=none"]])).toEqual([false, true]);
    expect(await withTxt([["v=DMARC1 p=none"]])).toEqual([false, true]);
    expect(await withTxt([["dmarc1; p=none"]])).toEqual([false, false]);
  });
  it("treats resolver errors (NXDOMAIN) as not-ok", async () => {
    const throwing: Resolver = {
      resolveNs: async () => [],
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
