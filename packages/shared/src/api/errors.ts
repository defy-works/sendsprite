/** REST error codes (spec §12) and the JSON error envelope. */
export const ERROR_CODES = [
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "domain_not_verified",
  "suppressed_recipient",
  "rate_limited",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "sandbox_restricted",
  "idempotency_conflict",
  "conflict",
  "payload_too_large",
  "not_configured",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  domain_not_verified: 422,
  suppressed_recipient: 422,
  rate_limited: 429,
  daily_quota_exceeded: 429,
  monthly_quota_exceeded: 429,
  sandbox_restricted: 422,
  idempotency_conflict: 409,
  conflict: 409,
  payload_too_large: 413,
  not_configured: 503,
  internal_error: 500,
};
