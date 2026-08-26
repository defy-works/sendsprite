/**
 * The two shapes every tool returns.
 *
 * Both carry a `text` block — clients that predate structured output only see
 * `content` — and the success shape repeats the payload as `structuredContent`
 * so a client that understands it does not have to re-parse JSON out of prose.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** What both helpers return: a `CallToolResult` whose content is one text block. */
export type ToolTextResult = CallToolResult;

const block = (value: unknown): CallToolResult["content"] => [
  { type: "text", text: JSON.stringify(value, null, 2) },
];

/** Success: `data` as pretty JSON text, and again as structured content. */
export function toolResult<T>(data: T): ToolTextResult {
  return {
    content: block(data),
    structuredContent: data as Record<string, unknown>,
  };
}

/** The `SendspriteError` fields the SDK sets; matched structurally. */
interface SendspriteErrorLike {
  code: string;
  status: number | null;
  message: string;
  details?: unknown;
  requestId?: string | null;
}

function isSendspriteError(e: unknown): e is SendspriteErrorLike {
  return (
    e instanceof Error &&
    e.name === "SendspriteError" &&
    typeof (e as { code?: unknown }).code === "string"
  );
}

/**
 * Failure: an `isError` *tool result*, never a protocol error.
 *
 * A failed API call is an outcome the model should read and act on (verify the
 * domain, wait out the rate limit, fix the address); a protocol error would
 * instead surface as a transport-level exception the model never sees. Anything
 * that is not a `SendspriteError` — a bug here, a broken socket — is reported
 * under `internal_error` rather than given a code it never had.
 */
export function toolError(e: unknown): ToolTextResult {
  const error = isSendspriteError(e)
    ? {
        code: e.code,
        status: e.status,
        message: e.message,
        ...(e.details === undefined ? {} : { details: e.details }),
        ...(e.requestId ? { requestId: e.requestId } : {}),
      }
    : {
        code: "internal_error",
        status: null,
        message: e instanceof Error ? e.message : String(e),
      };
  return { isError: true, content: block({ error }) };
}
