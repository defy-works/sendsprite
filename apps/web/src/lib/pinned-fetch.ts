/**
 * The pinned-connection half of webhook delivery, kept out of
 * `services/webhooks.ts` so it can be exercised without a database: the
 * verification script (`apps/web/scripts/verify-pin.ts`) imports it directly.
 */
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import type { FetchLike } from "@/lib/cloudflare/client";

/** Vetted DNS answers for one target, in `dns.lookup(..., { all: true })` shape. */
export type Resolved = { address: string; family: number }[];

/**
 * Response bytes buffered before the connection is torn down. Well above
 * the excerpt `services/webhooks.ts` keeps, and bounded, so an endpoint that
 * streams forever cannot fill the worker's memory (the old undici path
 * relied on cancelling the body stream for that).
 */
export const MAX_RESPONSE_BYTES = 8 * 1024;

/** Statuses the `Response` constructor refuses to pair with a body. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/** `node:http` hands back `string | string[] | undefined` per header. */
function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    // A hostile endpoint should cost us a failed attempt at worst, not an
    // exception: skip anything the Headers API rejects.
    try {
      if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      else headers.set(name, value);
    } catch {
      // Unrepresentable header; the excerpt does not need it.
    }
  }
  return headers;
}

/**
 * A fetch whose connections go only to `addrs` (the vetted answers) while
 * TLS still verifies the hostname.
 *
 * `node:http`/`node:https` take a `lookup` that replaces DNS resolution for
 * this request only; `host` stays the *hostname*, so certificate validation
 * (and the `Host` header) are entirely standard — connecting to the IP with
 * an overridden `servername` would not be. Both Bun and Node call `lookup`
 * with `all: true`, so the array form is the one that matters; the scalar
 * form is kept for contract completeness.
 *
 * This replaces undici, which Bun aliases to a builtin that ignores
 * `connect.lookup` — the pin was silently a no-op in the image, leaving the
 * TOCTOU window (DNS rebinding) that vetting the addresses is meant to close.
 *
 * Redirects are never followed: `node:http` does not follow them at all, so
 * a 3xx is returned as itself (`deliver` treats it as a failure).
 */
export function pinnedFetch(addrs: Resolved): FetchLike {
  const lookup: LookupFunction = (_hostname, opts, cb) => {
    const first = addrs[0]!;
    if (opts.all) cb(null, addrs);
    else cb(null, first.address, first.family);
  };
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const secure = u.protocol === "https:";
      // `URL.hostname` brackets an IPv6 literal; `host` wants it bare (Node
      // re-brackets it for the `Host` header itself).
      const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
      const headers = new Headers(init?.headers);
      // Node sends no `accept-encoding` and does not decompress, so ask for
      // none: a compressed reply would make `responseExcerpt` binary noise.
      if (!headers.has("accept-encoding"))
        headers.set("accept-encoding", "identity");
      const body = init?.body;
      if (body !== undefined && body !== null && typeof body !== "string") {
        reject(new Error("pinnedFetch supports a string body only"));
        return;
      }
      if (typeof body === "string" && !headers.has("content-length"))
        headers.set("content-length", String(Buffer.byteLength(body)));

      // The rejection reason is stored verbatim as `responseExcerpt`, so it
      // has to read as a diagnosis on its own.
      const signal = init?.signal ?? undefined;
      const aborted = () => {
        const reason: unknown = signal?.reason;
        return new Error(
          reason instanceof Error
            ? `request aborted: ${reason.message}`
            : "request aborted",
        );
      };
      if (signal?.aborted) {
        reject(aborted());
        return;
      }

      let settled = false;
      // Declared (hoisted) so `cleanup` can name it before `req` exists.
      function onAbort() {
        // `destroy(err)` surfaces on the request's `error` event, which is
        // already wired to reject.
        req.destroy(aborted());
      }
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      };
      const succeed = (res: Response) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      };

      const req = (secure ? https.request : http.request)({
        host,
        port: u.port || (secure ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(headers),
        lookup,
        // No shared agent: the global one pools sockets by host:port, so a
        // kept-alive connection could outlive the answers it was pinned to.
        // Every delivery gets its own connection.
        agent: false,
      });

      req.on("error", fail);
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        const finish = () => {
          const buf = Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES);
          succeed(
            new Response(
              NULL_BODY_STATUS.has(res.statusCode ?? 0) ? null : buf,
              {
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? "",
                headers: toHeaders(res.headers),
              },
            ),
          );
          // Whatever is still in flight is not wanted.
          req.destroy();
        };
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          n += chunk.length;
          if (n >= MAX_RESPONSE_BYTES) finish();
        });
        res.on("end", finish);
        res.on("error", fail);
      });

      if (typeof body === "string") req.end(body);
      else req.end();
    });
}
