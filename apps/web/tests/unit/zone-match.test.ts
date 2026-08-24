import { describe, expect, it } from "vitest";
import { matchZone } from "@/lib/dns/zone-match";

const zones = [
  { id: "z1", name: "acme.com" },
  { id: "z2", name: "mail.acme.com" },
  { id: "z3", name: "other.io" },
];

describe("matchZone", () => {
  it("picks the longest suffix zone", () => {
    expect(matchZone("x.mail.acme.com", zones)?.id).toBe("z2");
    expect(matchZone("mail.acme.com", zones)?.id).toBe("z2");
    expect(matchZone("acme.com", zones)?.id).toBe("z1");
    expect(matchZone("www.acme.com", zones)?.id).toBe("z1");
  });
  it("is case-insensitive and ignores a trailing dot", () => {
    expect(matchZone("Mail.ACME.com", zones)?.id).toBe("z2");
    expect(matchZone("x.mail.acme.com.", zones)?.id).toBe("z2");
    expect(matchZone("acme.com.", zones)?.id).toBe("z1");
  });
  it("returns null when no zone matches", () => {
    expect(matchZone("acme.com.evil.net", zones)).toBeNull();
    expect(matchZone("notacme.com", zones)).toBeNull();
    expect(matchZone("acme.com", [])).toBeNull();
  });
});
