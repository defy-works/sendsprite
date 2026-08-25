import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_RESPONSE_BYTES, pinnedFetch } from "@/lib/pinned-fetch";

/**
 * `pinnedFetch` is what stops a vetted DNS answer from being re-resolved (and
 * rebound) between the check and the connection. Every case here points the
 * pin at a loopback listener while the URL names a host that cannot resolve
 * at all: if the pin were ignored, none of these requests would arrive.
 */
const PIN = [{ address: "127.0.0.1", family: 4 }];
/** Reserved by RFC 2606: guaranteed never to resolve. */
const HOST = "pin.acme.invalid";

type Hit = { url: string; method: string; host?: string; body: string };
const hits: Hit[] = [];
let server: http.Server;
let port = 0;
/** Set by a test to steer the response for its own path. */
const routes = new Map<string, http.RequestListener>();

const url = (path: string) => `http://${HOST}:${port}${path}`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push({
        url: req.url ?? "",
        method: req.method ?? "",
        host: req.headers.host,
        body: Buffer.concat(chunks).toString(),
      });
      const route = routes.get(req.url ?? "");
      if (route) route(req, res);
      else res.writeHead(200, { "content-type": "text/plain" }).end("pong");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("pinnedFetch", () => {
  it("reaches the pinned address although the hostname does not resolve, and keeps the hostname on the wire", async () => {
    const res = await pinnedFetch(PIN)(url("/hook?x=1"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-sig": "abc" },
      body: '{"a":1}',
    });

    expect(res.status).toBe(200);
    expect(res.statusText).toBe("OK");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("pong");

    const hit = hits.at(-1)!;
    expect(hit).toMatchObject({
      url: "/hook?x=1",
      method: "POST",
      // The pin decides where the socket goes; the request still addresses
      // the original name, which is what keeps TLS verification standard.
      host: `${HOST}:${port}`,
      body: '{"a":1}',
    });
  });

  it("returns a 3xx as itself and never follows it", async () => {
    routes.set("/redirect", (_req, res) =>
      res.writeHead(302, { location: `/followed` }).end(),
    );
    const before = hits.length;
    const res = await pinnedFetch(PIN)(url("/redirect"), { method: "POST" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/followed");
    expect(hits.slice(before).map((h) => h.url)).toEqual(["/redirect"]);
  });

  it("rejects when the caller's signal aborts, with a message fit to store", async () => {
    routes.set("/hang", () => {
      // Never answers: only the timeout ends this.
    });
    await expect(
      pinnedFetch(PIN)(url("/hang"), {
        method: "POST",
        signal: AbortSignal.timeout(100),
      }),
    ).rejects.toThrow(/request aborted/);
  });

  it("rejects an already-aborted signal without connecting", async () => {
    const before = hits.length;
    await expect(
      pinnedFetch(PIN)(url("/never"), { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/request aborted/);
    expect(hits).toHaveLength(before);
  });

  it("caps an oversized body and tears the connection down", async () => {
    let torn = false;
    routes.set("/flood", (_req, res) => {
      res.writeHead(200);
      const chunk = "x".repeat(4096);
      const timer = setInterval(() => res.write(chunk), 1);
      res.on("close", () => {
        torn = true;
        clearInterval(timer);
      });
    });
    const res = await pinnedFetch(PIN)(url("/flood"), { method: "POST" });
    const text = await res.text();

    expect(text.length).toBe(MAX_RESPONSE_BYTES);
    // The endpoint is still writing; the socket must not stay open for it.
    await expect.poll(() => torn, { timeout: 5000 }).toBe(true);
  });

  it("rejects when the pinned address refuses the connection", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const closed = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));

    await expect(
      pinnedFetch(PIN)(`http://${HOST}:${closed}/hook`, { method: "POST" }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
