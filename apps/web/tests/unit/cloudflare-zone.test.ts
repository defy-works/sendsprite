import { describe, expect, it, vi } from "vitest";
import type { Resolver } from "@/lib/dns/check";
import {
  cloudflareDnsUrl,
  detectCloudflareZone,
} from "@/lib/dns/cloudflare-zone";

/** Answers NS only at the names in `zones`; everything else is NODATA. */
function resolver(zones: Record<string, string[]>) {
  const resolveNs = vi.fn(async (n: string) => {
    const ns = zones[n];
    if (!ns) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    return ns;
  });
  return {
    resolveNs,
    resolveCname: async () => [],
    resolveMx: async () => [],
    resolveTxt: async () => [],
  } satisfies Resolver & { resolveNs: typeof resolveNs };
}

const CF = ["kate.ns.cloudflare.com", "rob.ns.cloudflare.com"];

describe("detectCloudflareZone", () => {
  it("walks up to the delegation point and reports the zone", async () => {
    const r = resolver({ "example.com": CF });
    expect(await detectCloudflareZone("mail.example.com", r)).toBe(
      "example.com",
    );
    // It asked about the subdomain first, then the zone.
    expect(r.resolveNs.mock.calls.map((c) => c[0])).toEqual([
      "mail.example.com",
      "example.com",
    ]);
  });

  it("handles a multi-label suffix without a public-suffix list", async () => {
    const r = resolver({ "example.co.uk": CF });
    expect(await detectCloudflareZone("mail.example.co.uk", r)).toBe(
      "example.co.uk",
    );
  });

  it("matches when the domain is itself the zone", async () => {
    const r = resolver({ "example.com": CF });
    expect(await detectCloudflareZone("example.com", r)).toBe("example.com");
  });

  it("stops at the first delegation point rather than walking past it", async () => {
    // A zone cut at the subdomain that is NOT on Cloudflare must not be
    // rescued by the parent zone being on Cloudflare.
    const r = resolver({
      "mail.example.com": ["ns1.other.net"],
      "example.com": CF,
    });
    expect(await detectCloudflareZone("mail.example.com", r)).toBeNull();
  });

  it("is null for a zone served by someone else", async () => {
    const r = resolver({ "example.com": ["ns1.registrar.net"] });
    expect(await detectCloudflareZone("mail.example.com", r)).toBeNull();
  });

  it("is null when only some nameservers are Cloudflare's", async () => {
    const r = resolver({ "example.com": [CF[0]!, "ns1.registrar.net"] });
    expect(await detectCloudflareZone("mail.example.com", r)).toBeNull();
  });

  it("is null when nothing answers, and never asks about the bare TLD", async () => {
    const r = resolver({});
    expect(await detectCloudflareZone("mail.example.com", r)).toBeNull();
    expect(r.resolveNs.mock.calls.map((c) => c[0])).toEqual([
      "mail.example.com",
      "example.com",
    ]);
  });

  it("ignores case and a trailing dot", async () => {
    const r = resolver({ "example.com": CF.map((n) => `${n.toUpperCase()}.`) });
    expect(await detectCloudflareZone("Mail.Example.com.", r)).toBe(
      "example.com",
    );
  });
});

describe("cloudflareDnsUrl", () => {
  it("deep-links to the zone's records with the account placeholder", () => {
    expect(cloudflareDnsUrl("example.com")).toBe(
      "https://dash.cloudflare.com/?to=/:account/example.com/dns/records",
    );
  });
});
