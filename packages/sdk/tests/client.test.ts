import { afterEach, describe, expect, it, vi } from "vitest";
import { Sendsprite, SendspriteError } from "../src/index";

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const mock = (...responses: Response[]) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const r of responses) fetch.mockResolvedValueOnce(r);
  return fetch;
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Sendsprite client core", () => {
  it("sends the bearer key, JSON body and user-agent to <baseUrl>/api/v1", async () => {
    const fetch = mock(json(201, { id: "em_1" }));
    const c = new Sendsprite({
      apiKey: "ss_live_x",
      baseUrl: "https://mail.acme.com/",
      fetch,
    });
    const r = await c.request<{ id: string }>("POST", "/emails", {
      body: { from: "a@b.io" },
    });
    expect(r).toEqual({ id: "em_1" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://mail.acme.com/api/v1/emails");
    expect(init!.method).toBe("POST");
    expect(new Headers(init!.headers).get("authorization")).toBe(
      "Bearer ss_live_x",
    );
    expect(new Headers(init!.headers).get("user-agent")).toMatch(
      /^sendsprite-node\//,
    );
    expect(new Headers(init!.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(init!.body).toBe(JSON.stringify({ from: "a@b.io" }));
  });

  it("throws SendspriteError carrying code, status, message, details and requestId", async () => {
    const fetch = mock(
      json(
        422,
        {
          error: {
            code: "domain_not_verified",
            message: "Verify first.",
            details: { domain: "b.io" },
          },
        },
        { "x-request-id": "req_1" },
      ),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const err = (await c
      .request("POST", "/emails", {})
      .catch((e) => e)) as SendspriteError;
    expect(err).toBeInstanceOf(SendspriteError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SendspriteError");
    expect(err).toMatchObject({
      code: "domain_not_verified",
      status: 422,
      message: "Verify first.",
      details: { domain: "b.io" },
      requestId: "req_1",
    });
    expect(err.retryable).toBe(false);
  });

  it("retries 429 and 5xx with backoff, honouring retry-after, then succeeds", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor 1.0
    const fetch = mock(
      json(
        429,
        { error: { code: "rate_limited", message: "slow" } },
        { "retry-after": "2" },
      ),
      json(503, { error: { code: "internal_error", message: "x" } }),
      json(200, { ok: true }),
    );
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 3,
    });
    const p = c.request("GET", "/me");
    await vi.advanceTimersByTimeAsync(2_000); // retry-after
    await vi.advanceTimersByTimeAsync(1_000); // 2nd backoff (500ms * 2^1 = 1s)
    await expect(p).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx other than 429, and gives up after maxRetries", async () => {
    const fetch = mock(
      json(400, { error: { code: "validation_error", message: "bad" } }),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await expect(c.request("POST", "/emails", {})).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    const f2 = mock(
      json(500, { error: { code: "internal_error", message: "x" } }),
      json(500, { error: { code: "internal_error", message: "x" } }),
    );
    const c2 = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch: f2,
      maxRetries: 1,
    });
    const p = c2.request("GET", "/me").catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toMatchObject({ code: "internal_error", status: 500 });
    expect(f2).toHaveBeenCalledTimes(2);
  });

  it("never retries a POST /emails that has no idempotencyKey", async () => {
    vi.useFakeTimers();
    const fetch = mock(
      json(503, { error: { code: "internal_error", message: "x" } }),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const p = c
      .request("POST", "/emails", { body: { subject: "s" }, retry: false })
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("defaults retry to false for POST and true for other methods", async () => {
    vi.useFakeTimers();
    const post = mock(
      json(503, { error: { code: "not_configured", message: "x" } }),
    );
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch: post,
    });
    const p = c.request("POST", "/emails", { body: {} }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toMatchObject({ code: "not_configured", status: 503 });
    expect(post).toHaveBeenCalledTimes(1);

    const del = mock(
      json(503, { error: { code: "not_configured", message: "x" } }),
      new Response(null, { status: 204 }),
    );
    const c2 = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch: del,
    });
    const p2 = c2.request("DELETE", "/webhooks/wh_1");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p2).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledTimes(2);
  });

  it("retries a POST when retry: true is passed explicitly", async () => {
    vi.useFakeTimers();
    const fetch = mock(
      json(500, { error: { code: "internal_error", message: "x" } }),
      json(200, { id: "em_1" }),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const p = c.request("POST", "/emails/em_1/cancel", { retry: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toEqual({ id: "em_1" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially from 500ms, capped at 8s", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter factor 1.0
    const failures = Array.from({ length: 6 }, () =>
      json(500, { error: { code: "internal_error", message: "x" } }),
    );
    const fetch = mock(...failures, json(200, { ok: true }));
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 6,
    });
    const p = c.request("GET", "/me");
    const delays = [500, 1_000, 2_000, 4_000, 8_000, 8_000];
    for (const [i, d] of delays.entries()) {
      await vi.advanceTimersByTimeAsync(d - 1);
      expect(fetch).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(i + 2);
    }
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("appends query params, skipping undefined values", async () => {
    const fetch = mock(json(200, { data: [] }));
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await c.request("GET", "/emails", {
      query: { limit: 10, cursor: undefined, status: "sent" },
    });
    expect(fetch.mock.calls[0]![0]).toBe(
      "https://x/api/v1/emails?limit=10&status=sent",
    );
  });

  it("aborts on timeout and surfaces it as a network_error", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          init!.signal!.addEventListener("abort", () =>
            reject(init!.signal!.reason),
          );
        }),
    );
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 0,
      timeoutMs: 1_000,
    });
    const p = c.request("GET", "/me").catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = (await p) as SendspriteError;
    expect(err).toBeInstanceOf(SendspriteError);
    expect(err).toMatchObject({ code: "network_error", status: null });
    expect(err.retryable).toBe(true);
  });

  it("propagates a caller-supplied AbortSignal", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_, reject) => {
          init!.signal!.addEventListener("abort", () =>
            reject(init!.signal!.reason),
          );
        }),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const ac = new AbortController();
    const p = c.request("GET", "/me", { signal: ac.signal }).catch((e) => e);
    ac.abort(new Error("caller cancelled"));
    expect(await p).toMatchObject({
      code: "network_error",
      message: "caller cancelled",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("wraps network failures and non-JSON bodies", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("fetch failed"));
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 0,
    });
    await expect(c.request("GET", "/me")).rejects.toMatchObject({
      code: "network_error",
      message: "fetch failed",
      status: null,
    });
    const f2 = mock(new Response("<html>502</html>", { status: 502 }));
    const c2 = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch: f2,
      maxRetries: 0,
    });
    await expect(c2.request("GET", "/me")).rejects.toMatchObject({
      code: "internal_error",
      status: 502,
      message: "HTTP 502",
    });
  });

  it("maps non-JSON 4xx statuses to sensible codes", async () => {
    const cases: Array<[number, string]> = [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [429, "rate_limited"],
      [418, "validation_error"],
    ];
    for (const [status, code] of cases) {
      const fetch = mock(new Response("nope", { status }));
      const c = new Sendsprite({
        apiKey: "k",
        baseUrl: "https://x",
        fetch,
        maxRetries: 0,
      });
      await expect(c.request("GET", "/me")).rejects.toMatchObject({
        code,
        status,
      });
    }
  });

  it("reads SENDSPRITE_API_KEY / SENDSPRITE_URL when options are omitted", () => {
    vi.stubEnv("SENDSPRITE_API_KEY", "ss_live_env");
    vi.stubEnv("SENDSPRITE_URL", "https://env.example");
    try {
      const c = new Sendsprite();
      expect(c.baseUrl).toBe("https://env.example");
    } finally {
      vi.unstubAllEnvs();
    }
    vi.stubEnv("SENDSPRITE_API_KEY", undefined);
    vi.stubEnv("SENDSPRITE_URL", undefined);
    try {
      expect(() => new Sendsprite()).toThrow(/apiKey/);
      // No URL anywhere means the hosted instance, not an error.
      expect(new Sendsprite({ apiKey: "k" }).baseUrl).toBe(
        "https://sendsprite.com",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("review fix-ups", () => {
  const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, ...init });

  it("calls fetch without the client as receiver (browser-safe)", async () => {
    const fetch = vi.fn(function (this: unknown, ..._args: unknown[]) {
      expect(this === undefined || this === globalThis).toBe(true);
      return Promise.resolve(json({ ok: 1 }));
    }) as unknown as typeof globalThis.fetch;
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await expect(c.request("GET", "/me")).resolves.toEqual({ ok: 1 });
  });

  it("caps retry-after at 60 s and accepts an HTTP-date", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response("{}", {
            status: 503,
            headers: { "retry-after": "600" },
          }),
        )
        .mockResolvedValueOnce(
          new Response("{}", {
            status: 503,
            headers: {
              "retry-after": new Date(Date.now() + 5_000).toUTCString(),
            },
          }),
        )
        .mockResolvedValueOnce(json({ ok: 1 }));
      const c = new Sendsprite({
        apiKey: "k",
        baseUrl: "https://x",
        fetch,
        maxRetries: 2,
      });
      const p = c.request("GET", "/me");
      await vi.advanceTimersByTimeAsync(59_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_100);
      expect(fetch).toHaveBeenCalledTimes(3);
      await expect(p).resolves.toEqual({ ok: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborting during the backoff sleep throws promptly", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          new Response("{}", { status: 503, headers: { "retry-after": "30" } }),
        );
      const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
      const ac = new AbortController();
      const p = c.request("GET", "/me", { signal: ac.signal }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(10);
      ac.abort();
      await vi.advanceTimersByTimeAsync(10);
      await expect(p).resolves.toMatchObject({ status: 503 });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("2xx with an empty body resolves undefined; non-JSON 2xx is a SendspriteError", async () => {
    let fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    let c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await expect(c.request("GET", "/me")).resolves.toBeUndefined();

    fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("<html>", { status: 200 }));
    c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await expect(c.request("GET", "/me")).rejects.toBeInstanceOf(
      SendspriteError,
    );
  });

  it("maps a bare 409 to conflict and treats 501/505 as non-retryable", async () => {
    let fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("", { status: 409 }));
    let c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await expect(c.request("GET", "/me")).rejects.toMatchObject({
      code: "conflict",
    });
    for (const status of [501, 505]) {
      fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("", { status }));
      c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
      const err = await c.request("GET", "/me").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SendspriteError);
      expect((err as SendspriteError).retryable).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("fails fast when no fetch exists and none was passed", () => {
    vi.stubGlobal("fetch", undefined);
    expect(() => new Sendsprite({ apiKey: "k", baseUrl: "https://x" })).toThrow(
      "Sendsprite: no fetch available; pass options.fetch",
    );
    // An injected fetch is enough on a runtime without a global one.
    expect(
      () =>
        new Sendsprite({
          apiKey: "k",
          baseUrl: "https://x",
          fetch: vi.fn<typeof globalThis.fetch>(),
        }),
    ).not.toThrow();
  });

  it("derives the fallback error code from the status when the body has none", async () => {
    const table = [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_found"],
      [409, "conflict"],
      [413, "payload_too_large"],
      [429, "rate_limited"],
      [418, "validation_error"],
      [422, "validation_error"],
      [500, "internal_error"],
      [503, "internal_error"],
    ] as const;
    for (const [status, code] of table) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response("", { status }));
      const c = new Sendsprite({
        apiKey: "k",
        baseUrl: "https://x",
        fetch,
        maxRetries: 0,
      });
      await expect(c.request("GET", "/me")).rejects.toMatchObject({
        code,
        status,
      });
    }
  });
});
