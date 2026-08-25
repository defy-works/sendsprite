import { NextResponse } from "next/server";
import { HTTP_STATUS, PageQuery, type ErrorCode } from "@sendsprite/shared";
import type { Page } from "@/db/keyset";
import {
  authenticateApiKey,
  requireFullPermission,
  type ApiAuthOk,
} from "./api-auth";
import { usageSnapshot } from "@/services/send-limits";
import { isErrorCode, type Result } from "./result";

/** Error envelope (spec §12): `{ error: { code, message, details? } }`. */
export const fail = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  headers?: HeadersInit,
) =>
  NextResponse.json(
    { error: { code, message, ...(details !== undefined && { details }) } },
    { status: HTTP_STATUS[code], headers },
  );

export const ok = (
  data: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
) =>
  NextResponse.json(data, {
    status: init.status ?? 200,
    headers: init.headers,
  });

export const noContent = () => new Response(null, { status: 204 });

/**
 * One mapping from a failed service `Result` to the error envelope: a known
 * `ErrorCode` keeps its status, an upstream code (AWS error names) is a
 * 500, and no code at all means the input was rejected (400).
 */
export function serviceFailure(
  r: Extract<Result<unknown>, { ok: false }>,
  headers?: HeadersInit,
) {
  if (r.code === undefined)
    return fail("validation_error", r.error, r.details, headers);
  if (isErrorCode(r.code)) return fail(r.code, r.error, r.details, headers);
  return fail("internal_error", r.error, r.details, headers);
}

/**
 * The list GET in one call: parse `?limit=&cursor=`, run the paged service
 * call, map each row through its public view, and emit `{ data, nextCursor }`.
 */
export async function pagedList<T>(
  req: Request,
  list: (q: PageQuery) => Promise<Result<Page<T>>>,
  view: (row: T) => unknown,
): Promise<Response> {
  const q = parsePage(req);
  if (!q.ok) return q.res;
  const page = await list(q.data);
  if (!page.ok) return serviceFailure(page);
  return ok({
    data: page.data.data.map(view),
    nextCursor: page.data.nextCursor,
  });
}

/** `?limit=&cursor=` → `PageQuery`, or a 400 response. */
export function parsePage(req: Request) {
  const q = PageQuery.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  return q.success
    ? { ok: true as const, data: q.data }
    : {
        ok: false as const,
        res: fail(
          "validation_error",
          q.error.issues[0]?.message ?? "Invalid query.",
          q.error.issues,
        ),
      };
}

/** Largest JSON body accepted (a batch of base64 attachments). */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * 413 envelope when the declared body is over the cap, else null. Checked
 * before parsing so an oversized batch is refused without being buffered.
 * Only `content-length` is inspected: a chunked body has none, so the cap
 * on those is the reverse proxy's (`client_max_body_size` or equivalent).
 */
export function tooLarge(req: Request, headers?: HeadersInit) {
  const len = Number(req.headers.get("content-length"));
  return len > MAX_BODY_BYTES
    ? fail(
        "payload_too_large",
        `Request body must be at most ${MAX_BODY_BYTES} bytes.`,
        undefined,
        headers,
      )
    : null;
}

/**
 * `x-ratelimit-*` for the emails endpoints. With a team daily cap: limit,
 * remaining, and `reset` = next UTC midnight (epoch seconds), the cap's
 * window. Without one the SES 24-hour quota is shown instead; it is a
 * trailing window with no fixed reset, so `x-ratelimit-reset` is omitted.
 * No cap at all: `unlimited`, no reset.
 */
export async function rateHeaders(
  teamId: string,
  now = new Date(),
): Promise<Record<string, string>> {
  const u = await usageSnapshot(teamId, now);
  if (u.dailyLimit != null) {
    const reset = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    );
    return {
      "x-ratelimit-limit": String(u.dailyLimit),
      "x-ratelimit-remaining": String(Math.max(0, u.dailyLimit - u.dailyUsed)),
      "x-ratelimit-reset": String(Math.floor(reset / 1000)),
    };
  }
  if (u.instanceQuota != null)
    return {
      "x-ratelimit-limit": String(u.instanceQuota),
      "x-ratelimit-remaining": String(
        Math.max(0, u.instanceQuota - u.instanceUsed),
      ),
    };
  return {
    "x-ratelimit-limit": "unlimited",
    "x-ratelimit-remaining": "unlimited",
  };
}

/** Request body as JSON, or `undefined` when absent/unparseable (caller → 400). */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

/**
 * Next 16 route-handler context: `params` is a promise. Routes without a
 * dynamic segment receive an empty object.
 */
export type RouteContext = { params: Promise<Record<string, string>> };

type ApiHandler = (
  req: Request,
  auth: ApiAuthOk,
  ctx: RouteContext,
) => Promise<Response>;

/**
 * Wraps a handler: authenticates the bearer key, optionally requires a
 * `full` key, and turns thrown errors into a 500 `internal_error` envelope.
 */
export function withApiKey(
  handler: ApiHandler,
  opts: { permission?: "full" } = {},
) {
  return async (req: Request, ctx: RouteContext): Promise<Response> => {
    let auth = await authenticateApiKey(req.headers.get("authorization"));
    if (auth.ok && opts.permission === "full")
      auth = requireFullPermission(auth);
    if (!auth.ok) return fail(auth.code, auth.message);
    try {
      return await handler(req, auth, ctx);
    } catch (e) {
      console.error("[api]", e);
      return fail("internal_error", "Something went wrong.");
    }
  };
}
