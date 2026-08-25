import type { ErrorCode } from "@sendsprite/shared";

/** Every REST error code plus `network_error` (no response was received). */
export type SendspriteErrorCode = ErrorCode | "network_error";

export class SendspriteError extends Error {
  override readonly name = "SendspriteError";

  constructor(
    /** Machine-readable code from the error envelope. */
    readonly code: SendspriteErrorCode,
    message: string,
    /** HTTP status, or `null` when no response was received. */
    readonly status: number | null,
    /** Extra context from the error envelope (e.g. validation issues). */
    readonly details?: unknown,
    /** `x-request-id` of the failed response, for support. */
    readonly requestId?: string | null,
  ) {
    super(message);
  }

  /** True for network errors, 429 and 5xx: the request may be retried as-is. */
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}
