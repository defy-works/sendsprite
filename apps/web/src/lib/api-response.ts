import { NextResponse } from "next/server";
import { HTTP_STATUS, type ErrorCode } from "@sendsprite/shared";
import {
  authenticateApiKey,
  requireFullPermission,
  type ApiAuthOk,
} from "./api-auth";

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
