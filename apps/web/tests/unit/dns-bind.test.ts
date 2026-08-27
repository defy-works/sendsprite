import { describe, expect, it } from "vitest";
import { bindZoneFilename, toBindZone } from "@/lib/dns/bind";
import { expectedRecords } from "@/lib/dns/records";

const recs = expectedRecords({
  domain: "mail.acme.com",
  region: "eu-west-1",
  dkimTokens: ["tok1", "tok2", "tok3"],
  mailFromDomain: "bounce.mail.acme.com",
});

describe("toBindZone", () => {
  const zone = toBindZone("mail.acme.com", recs);
  const lines = zone.split("\n");

  it("declares origin and a TTL", () => {
    expect(lines).toContain("$ORIGIN mail.acme.com.");
    expect(lines).toContain("$TTL 3600");
  });

  it("has no SOA or NS — it adds to a zone, it does not define one", () => {
    expect(zone).not.toMatch(/\bSOA\b/);
    expect(zone).not.toMatch(/\bIN\s+NS\b/);
  });

  it("writes every DKIM CNAME with absolute names and targets", () => {
    expect(zone).toContain(
      "tok1._domainkey.mail.acme.com.\t3600\tIN\tCNAME\ttok1.dkim.amazonses.com.",
    );
    expect((zone.match(/IN\tCNAME/g) ?? []).length).toBe(3);
  });

  it("writes the MX with its priority and an absolute target", () => {
    expect(zone).toContain(
      "bounce.mail.acme.com.\t3600\tIN\tMX\t10 feedback-smtp.eu-west-1.amazonses.com.",
    );
  });

  it("quotes the SPF and DMARC TXT values", () => {
    expect(zone).toContain('IN\tTXT\t"v=spf1 include:amazonses.com ~all"');
    expect(zone).toContain(
      '_dmarc.mail.acme.com.\t3600\tIN\tTXT\t"v=DMARC1; p=none"',
    );
  });

  it("never emits a name with two trailing dots", () => {
    expect(zone).not.toMatch(/\.\.\s/);
  });

  it("is deterministic — same input, byte-identical output", () => {
    expect(toBindZone("mail.acme.com", recs)).toBe(zone);
  });

  it("splits a TXT value longer than 255 bytes into quoted chunks", () => {
    const long = "v=long; " + "a".repeat(300);
    const z = toBindZone("x.io", [
      {
        kind: "DMARC",
        type: "TXT",
        name: "_dmarc.x.io",
        value: long,
        ok: false,
      },
    ]);
    const strings = z.match(/"[^"]*"/g) ?? [];
    expect(strings.length).toBe(2);
    expect(strings.every((s) => s.length - 2 <= 255)).toBe(true);
  });

  it("escapes a quote inside a TXT value rather than closing the string", () => {
    const z = toBindZone("x.io", [
      {
        kind: "DMARC",
        type: "TXT",
        name: "_dmarc.x.io",
        value: 'a"b',
        ok: false,
      },
    ]);
    expect(z).toContain('"a\\"b"');
  });
});

describe("bindZoneFilename", () => {
  it("is a safe basename derived from the domain", () => {
    expect(bindZoneFilename("mail.acme.com")).toBe(
      "sendsprite-mail.acme.com.zone",
    );
    expect(bindZoneFilename("a/b c")).toBe("sendsprite-a_b_c.zone");
  });
});
