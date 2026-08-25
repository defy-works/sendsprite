import { describe, expect, it, vi } from "vitest";
import { Sendsprite } from "../src/index";
import { parseSse } from "../src/stream";

const sse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        const e = new TextEncoder();
        for (const ch of chunks) c.enqueue(e.encode(ch));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

/** A fetch that never responds and rejects with AbortError once its signal fires. */
const hanging = () =>
  vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(
      (_u, init) =>
        new Promise((_, rej) =>
          init!.signal!.addEventListener("abort", () =>
            rej(new DOMException("aborted", "AbortError")),
          ),
        ),
    );

describe("client.stream()", () => {
  it("parses change events and ignores comments; resolves when the server closes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        sse([
          ": connected\n\n",
          'event: change\ndata: {"type":"email","id":"em_1"}\n\n',
          ": ping\n\n",
          'event: change\ndata: {"type":"webhook"}\n\n',
        ]),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const seen: unknown[] = [];
    const s = c.stream({ onChange: (e) => seen.push(e), reconnect: false });
    await s.done;
    expect(seen).toEqual([{ type: "email", id: "em_1" }, { type: "webhook" }]);
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k");
    expect(new Headers(init.headers).get("accept")).toBe("text/event-stream");
    expect(fetch.mock.calls[0]![0]).toBe("https://x/api/v1/stream");
  });
  it("close() aborts the request", async () => {
    const fetch = hanging();
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const s = c.stream({ onChange: () => {}, reconnect: false });
    s.close();
    await expect(s.done).resolves.toBeUndefined();
  });
  it("an external signal aborting mid-stream resolves quietly", async () => {
    const fetch = hanging();
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const ac = new AbortController();
    const s = c.stream({ onChange: () => {}, signal: ac.signal });
    ac.abort();
    await expect(s.done).resolves.toBeUndefined();
  });
  it("surfaces a 403 as SendspriteError", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "forbidden", message: "full key required" },
        }),
        { status: 403 },
      ),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await expect(
      c.stream({ onChange: () => {}, reconnect: false }).done,
    ).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
  it("reconnects after a dropped connection and reports it via onError", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("socket hang up"))
      .mockResolvedValueOnce(
        sse(['event: change\ndata: {"type":"email","id":"em_2"}\n\n']),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const seen: unknown[] = [];
    const errors: unknown[] = [];
    vi.useFakeTimers();
    try {
      const s = c.stream({
        onChange: (e) => {
          seen.push(e);
          s.close();
        },
        onError: (e) => errors.push(e),
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await s.done;
    } finally {
      vi.useRealTimers();
    }
    expect(seen).toEqual([{ type: "email", id: "em_2" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "network_error" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("parseSse", () => {
  it("handles CRLF, multi-line data and chunk boundaries inside a line", async () => {
    const body = sse([
      "event: chan",
      'ge\r\ndata: {"a":\r\ndata: 1}\r\n\r\n',
      "data: last\n",
    ]).body!;
    const out = [];
    for await (const ev of parseSse(body)) out.push(ev);
    expect(out).toEqual([{ event: "change", data: '{"a":\n1}' }]);
  });
});
