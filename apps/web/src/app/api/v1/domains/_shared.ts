import type { ErrorCode } from "@sendsprite/shared";
import { fail } from "@/lib/api-response";

const CODES = new Set<ErrorCode>(["conflict", "forbidden", "not_found"]);

/** Domain service refusal → envelope; untyped refusals are validation errors. */
export const domainFailure = (r: { ok: false; error: string; code?: string }) =>
  fail(
    CODES.has(r.code as ErrorCode) ? (r.code as ErrorCode) : "validation_error",
    r.error,
  );
