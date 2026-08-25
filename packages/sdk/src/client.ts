import { SendspriteError, type SendspriteErrorCode } from "./errors";

export const SDK_VERSION = "0.1.0"; // kept in sync with package.json by the release pipeline

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

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
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
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** Perform one API call against `/api/v1<path>`, retrying per the options. */
  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const retry = options.retry ?? method.toUpperCase() !== "POST";

    for (let attempt = 0; ; attempt++) {
      const outcome = await this.attempt(method, url, options);

      if (outcome.ok) return outcome.value as T;

      const { error, retryAfterMs } = outcome;
      const exhausted = attempt >= this.maxRetries;
      const cancelled = options.signal?.aborted === true;
      if (!retry || !error.retryable || exhausted || cancelled) throw error;

      await sleep(retryAfterMs ?? backoffMs(attempt));
    }
  }

  private async attempt(
    method: string,
    url: URL,
    options: RequestOptions,
  ): Promise<Attempt> {
    let res: Response;
    try {
      res = await this.send(method, url, options);
    } catch (cause) {
      return { ok: false, error: networkError(cause), retryAfterMs: null };
    }

    if (res.ok) {
      const value = res.status === 204 ? undefined : await res.json();
      return { ok: true, value };
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
    options: RequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Request timed out")),
      this.timeoutMs,
    );
    const onOuterAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) onOuterAbort();
    else
      options.signal?.addEventListener("abort", onOuterAbort, { once: true });

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "user-agent": `sendsprite-node/${SDK_VERSION}`,
      accept: "application/json",
    };
    const hasBody = options.body !== undefined;
    if (hasBody) headers["content-type"] = "application/json";

    return this.fetchImpl(url.toString(), {
      method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    }).finally(() => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onOuterAbort);
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

/** `retry-after` in seconds → ms; `null` when absent or unparsable. */
function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function networkError(cause: unknown): SendspriteError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new SendspriteError("network_error", message, null);
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

function fallbackCode(status: number): SendspriteErrorCode {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "internal_error";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  return "validation_error";
}

const readEnv = (key: string): string | undefined =>
  typeof process !== "undefined" ? process.env?.[key] : undefined;
