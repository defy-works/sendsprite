import { SendspriteError, type SendspriteErrorCode } from "./errors";

export const SDK_VERSION = "0.2.0"; // kept in sync with package.json by the release pipeline

export interface SendspriteOptions {
  /** `ss_live_…` key; defaults to `SENDSPRITE_API_KEY`. */
  apiKey?: string;
  /** Your instance, e.g. `https://mail.acme.com`; defaults to `SENDSPRITE_URL`. */
  baseUrl?: string;
  /** Retries on 429/5xx/network errors (default 2). */
  maxRetries?: number;
  /** Per-request timeout in ms (default 30 000). */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /**
   * Whether 429/5xx/network failures are retried. Defaults to `true` for
   * every method except `POST`; set it explicitly for POSTs that are safe to
   * repeat (cancel/verify/test, or a send with an idempotency key).
   */
  retry?: boolean;
  signal?: AbortSignal;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;
/** Upper bound honoured for a server-sent `retry-after`. */
const MAX_RETRY_AFTER_MS = 60_000;

export class HttpClient {
  readonly baseUrl: string;
  /**
   * Per-request timeout; also how long `openStream` waits for the stream's
   * response headers. Not exported from the package — `HttpClient` itself is
   * internal — so this is only visible to the resources and to `stream.ts`.
   */
  readonly timeoutMs: number;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: SendspriteOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("SENDSPRITE_API_KEY");
    const baseUrl = options.baseUrl ?? readEnv("SENDSPRITE_URL");
    if (!apiKey) {
      throw new Error(
        "Sendsprite: apiKey is required (or set SENDSPRITE_API_KEY).",
      );
    }
    if (!baseUrl) {
      throw new Error(
        "Sendsprite: baseUrl is required (or set SENDSPRITE_URL).",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    // Browsers throw "Illegal invocation" when `fetch` is called with a
    // receiver other than `window`, so never call it as `this.fetchImpl(...)`
    // with an unbound global.
    const fetchImpl =
      options.fetch ??
      (typeof globalThis.fetch === "function"
        ? globalThis.fetch.bind(globalThis)
        : undefined);
    if (!fetchImpl) {
      // Node < 18, a polyfill-free jsdom, or a locked-down runtime.
      throw new Error("Sendsprite: no fetch available; pass options.fetch");
    }
    this.fetchImpl = fetchImpl;
  }

  /** Perform one API call against `/api/v1<path>`, retrying per the options. */
  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.url(path, options.query);
    const retry = options.retry ?? method.toUpperCase() !== "POST";
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);

    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attempt(method, url, body, options.signal);

      if (outcome.ok) return outcome.value as T;

      const { error, retryAfterMs } = outcome;
      const exhausted = attempt >= this.maxRetries;
      if (
        !retry ||
        !error.retryable ||
        exhausted ||
        options.signal?.aborted === true
      ) {
        throw error;
      }

      await sleep(retryAfterMs ?? backoffMs(attempt), options.signal);
      if (options.signal?.aborted) throw error;
    }
  }

  /**
   * One authenticated fetch of `/api/v1<path>` without retry, timeout or JSON
   * parsing — for long-lived responses such as the SSE stream. A non-2xx
   * status is mapped to a `SendspriteError` exactly like `request()`.
   */
  async raw(
    method: string,
    path: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const fetchImpl = this.fetchImpl;
    const res = await fetchImpl(this.url(path).toString(), {
      method,
      headers: { ...this.headers(false), ...headers },
      signal,
    });
    if (!res.ok) throw await responseError(res);
    return res;
  }

  private url(path: string, query?: RequestOptions["query"]): URL {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "user-agent": `sendsprite-node/${SDK_VERSION}`,
      accept: "application/json",
    };
    if (hasBody) headers["content-type"] = "application/json";
    return headers;
  }

  private async attempt(
    method: string,
    url: URL,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Attempt> {
    let res: Response;
    try {
      res = await this.send(method, url, body, signal);
    } catch (cause) {
      return { ok: false, error: networkError(cause), retryAfterMs: null };
    }

    if (res.ok) {
      return { ok: true, value: await successBody(res) };
    }
    return {
      ok: false,
      error: await responseError(res),
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    };
  }

  private send(
    method: string,
    url: URL,
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Request timed out")),
      this.timeoutMs,
    );
    const onOuterAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onOuterAbort();
    else signal?.addEventListener("abort", onOuterAbort, { once: true });

    const fetchImpl = this.fetchImpl;
    return fetchImpl(url.toString(), {
      method,
      headers: this.headers(body !== undefined),
      body,
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    });
  }
}

type Attempt =
  | { ok: true; value: unknown }
  | { ok: false; error: SendspriteError; retryAfterMs: number | null };

/** Exponential backoff: 500ms · 2^attempt with ±20% jitter, capped at 8s. */
function backoffMs(attempt: number): number {
  const base = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  const jitter = 0.8 + Math.random() * 0.4;
  return base * jitter;
}

/**
 * `retry-after` as delay-seconds or an HTTP-date → ms, capped at 60 s;
 * `null` when absent or unparsable.
 */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  let ms: number;
  if (Number.isFinite(seconds)) ms = seconds * 1000;
  else {
    const at = Date.parse(header);
    if (Number.isNaN(at)) return null;
    ms = at - Date.now();
  }
  return ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : null;
}

/** Sleep that returns early when `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function networkError(cause: unknown): SendspriteError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new SendspriteError("network_error", message, null);
}

/** 2xx body: `undefined` for 204/empty, parsed JSON otherwise. */
async function successBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new SendspriteError(
      "internal_error",
      `Expected a JSON response body (HTTP ${res.status})`,
      res.status,
      undefined,
      res.headers.get("x-request-id"),
    );
  }
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
}

/** Build the typed error for a non-2xx response; tolerates non-JSON bodies. */
async function responseError(res: Response): Promise<SendspriteError> {
  const body = (await res.json().catch(() => null)) as ErrorEnvelope | null;
  const code =
    (body?.error?.code as SendspriteErrorCode | undefined) ??
    fallbackCode(res.status);
  return new SendspriteError(
    code,
    body?.error?.message ?? `HTTP ${res.status}`,
    res.status,
    body?.error?.details,
    res.headers.get("x-request-id"),
  );
}

/** Codes the API would have sent, for responses whose body carried none. */
const STATUS_FALLBACK_CODES: Readonly<Record<number, SendspriteErrorCode>> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
};

function fallbackCode(status: number): SendspriteErrorCode {
  return (
    STATUS_FALLBACK_CODES[status] ??
    (status >= 500 ? "internal_error" : "validation_error")
  );
}

const readEnv = (key: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[key] : undefined;
