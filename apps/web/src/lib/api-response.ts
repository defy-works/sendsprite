import { NextResponse } from "next/server";
import { HTTP_STATUS, type ErrorCode } from "@sendsprite/shared";
import {
  authenticateApiKey,
  requireFullPermission,
  type ApiAuthOk,
} from "./api-auth";
import { usageSnapshot } from "@/services/send-limits";

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

/** Largest JSON body accepted (a batch of base64 attachments). */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;

/**
 * 413 envelope when the declared body is over the cap, else null. Checked
 * before parsing so an oversized batch is refused without being buffered.
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
 * `x-ratelimit-*` for the emails endpoints: the team's daily cap when set,
 * else the SES 24-hour quota, else `unlimited`. `reset` is the next UTC
 * midnight (the daily-cap window) as epoch seconds.
 */
export async function rateHeaders(
  teamId: string,
  now = new Date(),
): Promise<Record<string, string>> {
  const u = await usageSnapshot(teamId, now);
  const limit = u.dailyLimit ?? u.instanceQuota;
  const used = u.dailyLimit != null ? u.dailyUsed : u.instanceUsed;
  const reset = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return {
    "x-ratelimit-limit": limit == null ? "unlimited" : String(limit),
    "x-ratelimit-remaining":
      limit == null ? "unlimited" : String(Math.max(0, limit - used)),
    "x-ratelimit-reset": String(Math.floor(reset / 1000)),
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
