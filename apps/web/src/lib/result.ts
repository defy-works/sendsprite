import { ERROR_CODES, type ErrorCode } from "@sendsprite/shared";

/**
 * Service return shape: callers branch on `ok` instead of catching. `code` is
 * a shared `ErrorCode` when the refusal has one (the REST layer maps it to a
 * status via `serviceFailure`), or the upstream error name (e.g. an AWS
 * error name) when only that is known. `details` is extra envelope data
 * (e.g. the failing batch index).
 */
export type Result<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string; details?: unknown };

export const isErrorCode = (c: unknown): c is ErrorCode =>
  typeof c === "string" && (ERROR_CODES as readonly string[]).includes(c);
