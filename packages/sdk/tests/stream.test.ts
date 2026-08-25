import { describe, expect, it, vi } from "vitest";
import { Sendsprite, SendspriteError } from "../src/index";
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

const BAD_FRAME = "event: change\ndata: {not json}\n\n";

/**
 * A fetch that never responds and, like the platform's, rejects with its
 * signal's abort reason once that signal fires.
 */
const hanging = () =>
  vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(
      (_u, init) =>
        new Promise((_, rej) =>
          init!.signal!.addEventListener("abort", () =>
            rej(
              init!.signal!.reason ?? new DOMException("aborted", "AbortError"),
            ),
          ),
        ),
    );

/** An SSE response whose chunks are pushed by the test, one at a time. */
function controlledSse() {
  let push!: (chunk: string) => void;
  let end!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      push = (chunk) => c.enqueue(enc.encode(chunk));
      end = () => c.close();
    },
  });
  return {
    push,
    end,
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  };
}

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
  it("ready resolves on the server's first bytes, before any change lands", async () => {
    const feed = controlledSse();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(feed.response);
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const seen: unknown[] = [];
    const s = c.stream({ onChange: (e) => seen.push(e), reconnect: false });
    feed.push(": connected\n\n");
    await s.ready;
    // The whole point: once `ready` has resolved the subscription is live, so
    // an action taken from here on cannot have its change missed.
    expect(seen).toEqual([]);
    feed.push('event: change\ndata: {"type":"email","id":"em_1"}\n\n');
    feed.end();
    await s.done;
    expect(seen).toEqual([{ type: "email", id: "em_1" }]);
  });

  it("ready rejects with the refusal rather than hanging", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "forbidden", message: "full key required" },
        }),
        { status: 403 },
      ),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const s = c.stream({ onChange: () => {}, reconnect: false });
    await expect(s.ready).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it("ready rejects when the server closes without ever sending a frame", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(sse([]));
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const s = c.stream({ onChange: () => {}, reconnect: false });
    await expect(s.ready).rejects.toThrow(
      /closed before the server confirmed it was open/,
    );
    await expect(s.done).resolves.toBeUndefined();
  });

  it("times the connect out instead of parking on a server that never answers", async () => {
    // `raw()` applies no timeout — the body is long-lived on purpose — so the
    // wait for the *headers* is bounded here or nowhere.
    const fetch = hanging();
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      timeoutMs: 5_000,
    });
    vi.useFakeTimers();
    try {
      const s = c.stream({ onChange: () => {}, reconnect: false });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(s.done).rejects.toThrow(
        /Timed out after 5000ms waiting for the stream to open/,
      );
      await expect(s.ready).rejects.toThrow(/waiting for the stream to open/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects after a connect timeout when reconnect is on", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        (_u, init) =>
          new Promise((_, rej) =>
            init!.signal!.addEventListener("abort", () =>
              rej(init!.signal!.reason),
            ),
          ),
      )
      .mockResolvedValueOnce(
        sse([": connected\n\n", 'event: change\ndata: {"type":"email"}\n\n']),
      );
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      timeoutMs: 5_000,
    });
    const errors: SendspriteError[] = [];
    vi.useFakeTimers();
    try {
      const s = c.stream({
        onChange: () => {},
        onError: (e) => errors.push(e),
        reconnect: true,
      });
      await vi.advanceTimersByTimeAsync(5_000); // connect deadline
      await vi.advanceTimersByTimeAsync(1_000); // first backoff
      await s.ready;
      s.close();
      await s.done;
    } finally {
      vi.useRealTimers();
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/waiting for the stream to open/);
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

  it("backs off when the server accepts and then immediately drops", async () => {
    // The reset of the backoff counter belongs *after* the first parsed event,
    // not after connecting: otherwise this server is hammered once a second.
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(sse([])));
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    vi.useFakeTimers();
    try {
      const s = c.stream({ onChange: () => {} });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(2); // second wait is 2s, not 1s
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(3);
      s.close();
      await s.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the backoff once a connection has delivered an event", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(sse(['event: change\ndata: {"type":"email"}\n\n'])),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    vi.useFakeTimers();
    try {
      const s = c.stream({ onChange: () => {} });
      for (const expected of [2, 3, 4]) {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetch).toHaveBeenCalledTimes(expected);
      }
      s.close();
      await s.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects done with the caller's own error when onChange throws", async () => {
    const boom = new Error("handler blew up");
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          sse(['event: change\ndata: {"type":"email","id":"em_1"}\n\n']),
        ),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const errors: unknown[] = [];
    const s = c.stream({
      onChange: () => {
        throw boom;
      },
      onError: (e) => errors.push(e),
    });
    await expect(s.done).rejects.toBe(boom);
    // Not relabelled as network_error, and no reconnect.
    expect(errors).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("skips a malformed data frame instead of reconnecting", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        sse([
          "event: change\ndata: {not json}\n\n",
          'event: change\ndata: {"type":"email","id":"em_9"}\n\n',
        ]),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const seen: unknown[] = [];
    const errors: SendspriteError[] = [];
    const s = c.stream({
      onChange: (e) => seen.push(e),
      onError: (e) => errors.push(e),
      reconnect: false,
    });
    await s.done;
    expect(seen).toEqual([{ type: "email", id: "em_9" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SendspriteError);
    expect(errors[0]!.message).toMatch(/Malformed SSE data frame/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not reset the backoff for a frame it could not parse", async () => {
    // A server stuck emitting garbage is as broken as one that drops the
    // connection; it must not be retried once a second forever.
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(sse([BAD_FRAME])));
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    vi.useFakeTimers();
    try {
      const s = c.stream({ onChange: () => {}, onError: () => {} });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(2); // second wait is 2s, not 1s
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetch).toHaveBeenCalledTimes(3);
      s.close();
      await s.done;
    } finally {
      vi.useRealTimers();
    }
  });

  it("pre-handles `done` so ignoring it cannot crash the process", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    // Via the EventEmitter view: bun-types shadows `process.off`'s generic
    // overload with its `memoryPressure` one.
    const events: NodeJS.EventEmitter = process;
    events.on("unhandledRejection", onUnhandled);
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ error: { code: "forbidden", message: "no" } }),
            { status: 403 },
          ),
        );
      const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
      // `done` deliberately not awaited: fire-and-forget tailing is legal.
      c.stream({ onChange: () => {}, reconnect: false });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      events.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe("parseSse", () => {
  it("cancels the body stream when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode('event: change\ndata: {"type":"email"}\n\n'),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const ev of parseSse(body)) {
      expect(ev).toEqual({
        kind: "event",
        event: "change",
        data: '{"type":"email"}',
      });
      break; // the stream never ends on its own; `finally` must cancel it
    }
    expect(cancelled).toBe(true);
  });

  it("handles CRLF, multi-line data and chunk boundaries inside a line", async () => {
    const body = sse([
      "event: chan",
      'ge\r\ndata: {"a":\r\ndata: 1}\r\n\r\n',
      "data: last\n",
    ]).body!;
    const out = [];
    for await (const ev of parseSse(body)) out.push(ev);
    expect(out).toEqual([
      { kind: "event", event: "change", data: '{"a":\n1}' },
    ]);
  });
});
