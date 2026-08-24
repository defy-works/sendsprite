import { describe, expect, it } from "vitest";
import {
  CloudflareClient,
  CloudflareError,
  type FetchLike,
} from "@/lib/cloudflare/client";

type Route = (init?: RequestInit) => unknown;

/** Fake fetch: routes are matched by longest key so `/dns_records/r1` beats `/dns_records`. */
function fake(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = keys.find((k) => url.includes(k));
    if (!key)
      return new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 404, message: "no route" }],
        }),
        { status: 404 },
      );
    return new Response(
      JSON.stringify({ success: true, result: routes[key]!(init) }),
      { status: 200 },
    );
  };
  return { fetch: f as FetchLike, calls };
}

const method = (calls: { url: string; init?: RequestInit }[], suffix: string) =>
  calls.filter((c) => c.url.endsWith(suffix)).map((c) => c.init?.method);

describe("CloudflareClient", () => {
  it("verifies token and lists zones", async () => {
    const { fetch, calls } = fake({
      "/user/tokens/verify": () => ({ status: "active" }),
      "/zones?": () => [{ id: "z1", name: "acme.com" }],
    });
    const cf = new CloudflareClient("tok", fetch);
    expect(await cf.verifyToken()).toEqual({ status: "active" });
    expect(await cf.listZones()).toEqual([{ id: "z1", name: "acme.com" }]);
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: "Bearer tok",
    });
  });

  it("upserts CNAME/MX by type+name: patches when present, creates when absent", async () => {
    const { fetch, calls } = fake({
      "/zones/z1/dns_records?": (init) =>
        init?.method === undefined &&
        calls.at(-1)!.url.includes("name=a._domainkey.acme.com")
          ? [
              {
                id: "r1",
                type: "CNAME",
                name: "a._domainkey.acme.com",
                content: "old",
              },
            ]
          : [],
      "/zones/z1/dns_records/r1": () => ({ id: "r1" }),
      "/zones/z1/dns_records": () => ({ id: "r2" }),
    });
    const cf = new CloudflareClient("tok", fetch);
    expect(
      await cf.upsertRecord("z1", {
        type: "CNAME",
        name: "a._domainkey.acme.com",
        content: "new",
      }),
    ).toEqual({ id: "r1" });
    expect(method(calls, "/dns_records/r1")).toEqual(["PATCH"]);
    expect(
      await cf.upsertRecord("z1", {
        type: "CNAME",
        name: "b._domainkey.acme.com",
        content: "y",
      }),
    ).toEqual({ id: "r2" });
    expect(method(calls, "/dns_records")).toEqual(["POST"]);
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(String(post.init?.body))).toMatchObject({
      type: "CNAME",
      name: "b._domainkey.acme.com",
      content: "y",
      ttl: 1,
      proxied: false,
    });
  });

  it("upserts TXT by type+name+content: same content patches, different content creates", async () => {
    const { fetch, calls } = fake({
      "/zones/z1/dns_records?": () => [
        { id: "r1", type: "TXT", name: "acme.com", content: "v=spf1 -all" },
      ],
      "/zones/z1/dns_records/r1": () => ({ id: "r1" }),
      "/zones/z1/dns_records": () => ({ id: "r2" }),
    });
    const cf = new CloudflareClient("tok", fetch);
    // A verification TXT next to an existing SPF must not overwrite the SPF.
    expect(
      await cf.upsertRecord("z1", {
        type: "TXT",
        name: "acme.com",
        content: "verify=abc",
      }),
    ).toEqual({ id: "r2" });
    expect(method(calls, "/dns_records")).toEqual(["POST"]);
    expect(
      await cf.upsertRecord("z1", {
        type: "TXT",
        name: "acme.com",
        content: "v=spf1 -all",
      }),
    ).toEqual({ id: "r1" });
    expect(method(calls, "/dns_records/r1")).toEqual(["PATCH"]);
  });

  it("surfaces Cloudflare error messages with their code", async () => {
    const f: FetchLike = async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
        { status: 403 },
      );
    const err = await new CloudflareClient("bad", f)
      .verifyToken()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareError);
    expect((err as CloudflareError).message).toMatch(/Authentication error/);
    expect((err as CloudflareError).code).toBe(10000);
  });

  it("falls back to the HTTP status when the body is not JSON", async () => {
    const f: FetchLike = async () =>
      new Response("<html>bad gateway</html>", { status: 502 });
    await expect(new CloudflareClient("tok", f).listZones()).rejects.toThrow(
      /Cloudflare 502/,
    );
  });
});
