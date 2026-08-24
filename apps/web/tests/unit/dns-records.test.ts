import { describe, expect, it } from "vitest";
import { expectedRecords } from "@/lib/dns/records";

describe("expectedRecords", () => {
  const recs = expectedRecords({
    domain: "mail.acme.com",
    region: "eu-west-1",
    dkimTokens: ["a1", "b2", "c3"],
    mailFromDomain: "bounce.mail.acme.com",
  });
  it("emits 3 DKIM CNAMEs, MAIL FROM MX + SPF, and DMARC", () => {
    expect(recs.map((r) => r.kind)).toEqual([
      "DKIM",
      "DKIM",
      "DKIM",
      "MAIL_FROM_MX",
      "MAIL_FROM_SPF",
      "DMARC",
    ]);
    expect(recs[0]).toMatchObject({
      type: "CNAME",
      name: "a1._domainkey.mail.acme.com",
      value: "a1.dkim.amazonses.com",
      ok: false,
    });
    expect(recs[3]).toMatchObject({
      type: "MX",
      name: "bounce.mail.acme.com",
      value: "feedback-smtp.eu-west-1.amazonses.com",
      priority: 10,
    });
    expect(recs[4]).toMatchObject({
      type: "TXT",
      name: "bounce.mail.acme.com",
      value: "v=spf1 include:amazonses.com ~all",
    });
    expect(recs[5]).toMatchObject({
      type: "TXT",
      name: "_dmarc.mail.acme.com",
      value: "v=DMARC1; p=none; rua=mailto:dmarc@mail.acme.com",
    });
    expect(recs.every((r) => r.ok === false)).toBe(true);
  });
  it("honours an explicit DMARC policy", () => {
    const [dmarc] = expectedRecords({
      domain: "acme.com",
      region: "us-east-1",
      dkimTokens: [],
      mailFromDomain: "b.acme.com",
      dmarcPolicy: "quarantine",
    }).filter((r) => r.kind === "DMARC");
    expect(dmarc?.value).toBe(
      "v=DMARC1; p=quarantine; rua=mailto:dmarc@acme.com",
    );
  });
});
