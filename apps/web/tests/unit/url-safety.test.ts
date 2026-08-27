import { describe, expect, it } from "vitest";
import { isPublicHttpUrl, isPublicIp } from "@/lib/url-safety";

describe("isPublicHttpUrl", () => {
  it("accepts public http(s) hosts and IPs", () => {
    for (const u of [
      "https://hooks.acme.com/x",
      "https://hooks.acme.com:8443/x?y=1",
      "http://example.org/",
      "https://8.8.8.8/",
      "https://[2606:4700::1111]/",
      "https://[::ffff:8.8.8.8]/",
      "https://my.internal.acme.com/", // only the `.internal` TLD is rejected
    ])
      expect(isPublicHttpUrl(u), u).toBe(true);
  });

  it("rejects other schemes, credentials and unparseable input", () => {
    for (const u of [
      "ftp://hooks.acme.com/",
      "javascript:alert(1)",
      "https://user:pw@hooks.acme.com/",
      "hooks.acme.com/x",
      "",
    ])
      expect(isPublicHttpUrl(u), u).toBe(false);
    expect(isPublicHttpUrl("http://hooks.acme.com/", { httpsOnly: true })).toBe(
      false,
    );
  });

  it("rejects local names and single-label hosts", () => {
    for (const u of [
      "https://localhost/",
      "https://LOCALHOST:3000/",
      "https://api.localhost/",
      "https://printer.local/",
      "https://vault.internal/",
      "https://intranet/",
    ])
      expect(isPublicHttpUrl(u), u).toBe(false);
  });

  it("rejects private, loopback, link-local, CGNAT and reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.254",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "169.254.0.1",
      "100.64.0.1",
      "100.127.255.255",
      "224.0.0.1",
      "255.255.255.255",
    ])
      expect(isPublicHttpUrl(`https://${ip}/`), ip).toBe(false);
    for (const ip of ["172.32.0.1", "100.128.0.1", "11.0.0.1", "223.1.1.1"])
      expect(isPublicHttpUrl(`https://${ip}/`), ip).toBe(true);
  });

  it("rejects IPv6 loopback, unspecified, ULA, link-local and mapped-private", () => {
    for (const ip of [
      "::1",
      "::",
      "0:0:0:0:0:0:0:1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "febf::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
    ])
      expect(isPublicHttpUrl(`https://[${ip}]/`), ip).toBe(false);
    expect(isPublicHttpUrl("https://[fec0::1]/")).toBe(true); // not fe80::/10
  });
});

describe("isPublicIp", () => {
  it("vets bare resolved addresses the way the URL check vets literals", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111", "fec0::1"])
      expect(isPublicIp(ip), ip).toBe(true);
    for (const ip of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "not-an-ip",
      "",
    ])
      expect(isPublicIp(ip), ip).toBe(false);
  });
});
