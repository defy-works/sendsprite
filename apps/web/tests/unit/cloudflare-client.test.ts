import { describe, expect, it } from "vitest";
import {
  CloudflareClient,
  CloudflareError,
  txtKey,
  type FetchLike,
} from "@/lib/cloudflare/client";

type Route = (url: string, init?: RequestInit) => unknown;

/** Fake fetch: routes are matched by longest key so `/dns_records/r1` beats `/dns_records`. */
function fake(routes: Record<string, Route>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  const f: FetchLike = async (url, init) => {
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
    const out = routes[key]!(url, init);
    return out instanceof Response
      ? out
      : new Response(JSON.stringify({ success: true, result: out }), {
          status: 200,
        });
  };
  return { fetch: f, calls };
}

const method = (calls: { url: string; init?: RequestInit }[], suffix: string) =>
  calls.filter((c) => c.url.endsWith(suffix)).map((c) => c.init?.method);

const txtZone = (existing: { id: string; content: string }[]) =>
  fake({
    "/zones/z1/dns_records?": () =>
      existing.map((e) => ({ ...e, type: "TXT", name: "acme.com" })),
    "/zones/z1/dns_records/": (url) => ({ id: url.split("/").pop() }),
    "/zones/z1/dns_records": () => ({ id: "new" }),
  });

describe("CloudflareClient", () => {
  it("lists zones with the token as a bearer", async () => {
    const { fetch, calls } = fake({
      "/zones?": () => [{ id: "z1", name: "acme.com" }],
    });
    const cf = new CloudflareClient("tok", fetch);
    expect(await cf.listZones()).toEqual([{ id: "z1", name: "acme.com" }]);
    expect(calls[0]!.init?.headers).toMatchObject({
      authorization: "Bearer tok",
    });
  });

  it("pages through zones using result_info.total_pages", async () => {
    const { fetch, calls } = fake({
      "/zones?": (url) => {
        const page = Number(new URL(url).searchParams.get("page"));
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ id: `z${page}`, name: `p${page}.com` }],
            result_info: { page, total_pages: 2 },
          }),
        );
      },
    });
    expect(await new CloudflareClient("tok", fetch).listZones()).toEqual([
      { id: "z1", name: "p1.com" },
      { id: "z2", name: "p2.com" },
    ]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual([
      "1",
      "2",
    ]);
  });

  it("upserts CNAME/MX by type+name: patches when present, creates when absent", async () => {
    const { fetch, calls } = fake({
      "/zones/z1/dns_records?": (url) =>
        url.includes("name=a._domainkey.acme.com")
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

  it("upserts SPF/DMARC TXT by prefix: one per name, so a differing one is patched", async () => {
    const { fetch, calls } = txtZone([
      { id: "spf", content: '"v=spf1  include:other.net -all"' },
      { id: "dmarc", content: "v=DMARC1; p=reject" },
      { id: "tok", content: "verify=abc" },
    ]);
    const cf = new CloudflareClient("tok", fetch);
    // Quoted, differently-spaced existing SPF → PATCH, never a second SPF.
    expect(
      await cf.upsertRecord("z1", {
        type: "TXT",
        name: "acme.com",
        content: "v=spf1 include:amazonses.com ~all",
      }),
    ).toEqual({ id: "spf" });
    // Existing DMARC with different content → PATCH, not POST.
    expect(
      await cf.upsertRecord("z1", {
        type: "TXT",
        name: "acme.com",
        content: "v=DMARC1; p=none",
      }),
    ).toEqual({ id: "dmarc" });
    expect(method(calls, "/dns_records/spf")).toEqual(["PATCH"]);
    expect(method(calls, "/dns_records/dmarc")).toEqual(["PATCH"]);
    expect(method(calls, "/dns_records")).toEqual([]);
  });

  it("upserts other TXT by exact normalised content: unrelated content at the same name is created", async () => {
    const { fetch, calls } = txtZone([
      { id: "spf", content: "v=spf1 -all" },
      { id: "tok", content: '"verify=abc"' },
    ]);
    const cf = new CloudflareClient("tok", fetch);
    expect(
      await cf.upsertRecord("z1", {
        type: "TXT",
        name: "acme.com",
        content: "verify=xyz",
      }),
    ).toEqual({ id: "new" });
    expect(method(calls, "/dns_records")).toEqual(["POST"]);
    // Same content modulo quotes/whitespace → PATCH.
    expect(
      await cf.upsertRecord("z1", {
        type: "TXT",
        name: "acme.com",
        content: " verify=abc ",
      }),
    ).toEqual({ id: "tok" });
    expect(method(calls, "/dns_records/tok")).toEqual(["PATCH"]);
  });

  it("txtKey keys SPF/DMARC by prefix and other TXT by content", () => {
    expect(txtKey('"V=SPF1 -all"')).toBe("v=spf1");
    expect(txtKey("v=DMARC1; p=none")).toBe("v=dmarc1");
    expect(txtKey("v=spf10 x")).toBe("v=spf10 x");
    expect(txtKey('  "a   b" ')).toBe("a b");
  });

  it("deleteRecord treats an already-missing record as deleted", async () => {
    const gone = (body: BodyInit, status: number) =>
      new CloudflareClient("tok", async () => new Response(body, { status }));
    const cfErr = (code: number, status: number) =>
      gone(
        JSON.stringify({
          success: false,
          errors: [{ code, message: "Record does not exist." }],
        }),
        status,
      );
    expect(await cfErr(81044, 400).deleteRecord("z1", "r1")).toEqual({
      id: "r1",
    });
    expect(await cfErr(7003, 404).deleteRecord("z1", "r1")).toEqual({
      id: "r1",
    });
    expect(
      await gone("<html>not found</html>", 404).deleteRecord("z1", "r1"),
    ).toEqual({ id: "r1" });
    await expect(cfErr(10000, 403).deleteRecord("z1", "r1")).rejects.toThrow(
      /Record does not exist/,
    );
  });

  it("surfaces Cloudflare error messages with their code and status", async () => {
    const f: FetchLike = async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
        { status: 403 },
      );
    const err = await new CloudflareClient("bad", f)
      .listZones()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareError);
    expect((err as CloudflareError).message).toMatch(/Authentication error/);
    expect((err as CloudflareError).code).toBe(10000);
    expect((err as CloudflareError).status).toBe(403);
  });

  it("falls back to the HTTP status when the body is not JSON", async () => {
    const f: FetchLike = async () =>
      new Response("<html>bad gateway</html>", { status: 502 });
    await expect(new CloudflareClient("tok", f).listZones()).rejects.toThrow(
      /Cloudflare 502/,
    );
  });
});
