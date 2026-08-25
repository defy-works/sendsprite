import type { HttpClient } from "./client";
import { SendspriteError } from "./errors";
import type { StreamChange } from "./types";

export interface StreamOptions {
  /** Called for every `change` event (`{ type: "email" | "webhook", id? }`). */
  onChange: (change: StreamChange) => void;
  /**
   * Called with every error the stream survives: the failure that dropped a
   * connection before each reconnect, and a `data:` frame that could not be
   * parsed (which is skipped, not reconnected). An error thrown by `onChange`
   * is *not* reported here — it rejects `done` instead.
   */
  onError?: (err: SendspriteError) => void;
  /** Reconnect with backoff after a dropped connection (default `true`). */
  reconnect?: boolean;
  /** Aborting this signal closes the stream (same as `close()`). */
  signal?: AbortSignal;
}

export interface StreamHandle {
  /** Abort the connection; `done` then resolves. */
  close(): void;
  /**
   * Resolves when the stream was closed (by `close()`, the `signal`, or the
   * server when `reconnect: false`); rejects with a non-retryable
   * `SendspriteError` (e.g. 401/403), any error when `reconnect: false`, or
   * the error thrown by `onChange` (unwrapped, and the stream stops).
   */
  readonly done: Promise<void>;
}

const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Marks an exception thrown by the caller's `onChange` so the reconnect loop
 * never mistakes their bug for a transport failure.
 */
class CallerError {
  constructor(readonly cause: unknown) {}
}

/** Open `GET /api/v1/stream` (SSE) and dispatch `change` events. */
export function openStream(
  http: HttpClient,
  opts: StreamOptions,
): StreamHandle {
  const ac = new AbortController();
  const closeFromSignal = () => ac.abort(opts.signal?.reason);
  if (opts.signal?.aborted) closeFromSignal();
  else opts.signal?.addEventListener("abort", closeFromSignal, { once: true });

  const run = async (): Promise<void> => {
    let attempt = 0;
    while (!ac.signal.aborted) {
      try {
        const res = await http.raw(
          "GET",
          "/stream",
          { accept: "text/event-stream" },
          ac.signal,
        );
        for await (const ev of parseSse(res.body ?? emptyStream())) {
          if (ac.signal.aborted) return;
          if (ev.event !== "change") continue;
          let change: StreamChange;
          try {
            change = JSON.parse(ev.data) as StreamChange;
          } catch (cause) {
            // A frame we cannot parse is the server's problem, not the
            // connection's — skip it instead of tearing the stream down.
            opts.onError?.(
              new SendspriteError(
                "internal_error",
                `Malformed SSE data frame: ${describe(cause)}`,
                null,
              ),
            );
            continue;
          }
          // Reset only once the connection has delivered a usable event: a
          // server that accepts and then immediately drops — or that only ever
          // emits garbage — must still back off rather than be hammered every
          // second.
          attempt = 0;
          try {
            opts.onChange(change);
          } catch (cause) {
            throw new CallerError(cause);
          }
        }
        // Server closed the connection cleanly.
        if (opts.reconnect === false) return;
      } catch (cause) {
        // The caller's handler threw: surface their error as-is and stop.
        // Deliberately no `ac.abort()` here — leaving the loop already ran
        // `parseSse`'s `finally`, which cancels the response body, and
        // aborting would flip `ac.signal.aborted` so `done`'s catch below
        // swallowed the very error we are propagating.
        if (cause instanceof CallerError) throw cause.cause;
        if (ac.signal.aborted) return;
        const err =
          cause instanceof SendspriteError
            ? cause
            : new SendspriteError("network_error", describe(cause), null);
        if (!err.retryable || opts.reconnect === false) throw err;
        opts.onError?.(err);
      }
      await sleep(
        Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** attempt++),
        ac.signal,
      );
    }
  };

  const done = run()
    .catch((err: unknown) => {
      if (!ac.signal.aborted) throw err;
    })
    .finally(() => opts.signal?.removeEventListener("abort", closeFromSignal));

  // Callers may legitimately ignore `done` (fire-and-forget tailing). Attach a
  // no-op catch so a rejection is never "unhandled" — that would take the Node
  // process down — while the same promise still rejects for whoever awaits it.
  void done.catch(() => {});
  return { close: () => ac.abort(), done };
}

/**
 * Minimal SSE parser: `event:` and `data:` fields, a blank line dispatches,
 * `:` comment lines are ignored, CRLF tolerated, multi-line `data` joined
 * with `\n`. Anything left in the buffer when the body ends is discarded.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
        } else if (line.startsWith(":")) {
          continue;
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
  } finally {
    // `cancel()` rather than a bare `releaseLock()`: `close()`, a `break` and
    // an exception thrown by the consumer must all tear the body down.
    await reader.cancel().catch(() => {});
  }
}

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

const emptyStream = () =>
  new ReadableStream<Uint8Array>({
    start: (c) => c.close(),
  });

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
