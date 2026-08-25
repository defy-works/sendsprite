/**
 * `sendsprite/next`: verify and dispatch Sendsprite webhooks from a Next.js
 * route handler (or any Web-`Request` runtime — Hono, Remix, Bun.serve).
 *
 * ```ts
 * // app/api/webhooks/sendsprite/route.ts
 * import { createWebhookHandler } from "sendsprite/next";
 *
 * export const POST = createWebhookHandler({
 *   secret: process.env.SENDSPRITE_WEBHOOK_SECRET!,
 *   on: { "email.bounced": async (event) => suppress(event.data) },
 * });
 * ```
 *
 * The signature is an HMAC over the *raw* body, so this entry reads
 * `req.text()` itself — never parse the body before handing the request over.
 * It needs `node:crypto`, which keeps it off the edge runtime; the root
 * `sendsprite` entry stays runtime-agnostic.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEventType, WebhookPayload } from "./types";

export type { WebhookEventType, WebhookPayload };

/**
 * The scheme implemented by `@sendsprite/shared`'s `signWebhook` /
 * `verifyWebhookSignature`, re-implemented here in ~15 lines rather than
 * imported: that package is private, its root barrel is not side-effect free,
 * and inlining it would drag all of zod (≈540 KB) into the published bundle.
 * `tests/next.test.ts` signs its requests with the *real* server-side helper,
 * so the two cannot drift apart unnoticed.
 */
const SIGNATURE_HEADER = "sendsprite-signature";
const EVENT_ID_HEADER = "sendsprite-event-id";
const TOLERANCE_SECONDS = 300;
const SIGNATURE_RE = /^t=(\d+),v1=([a-f0-9]{64})$/;

/** Thrown when a request is not a genuine, fresh Sendsprite delivery. */
export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";
}

/** Constant-time check of `t=<unix seconds>,v1=<hmac-sha256 of "<t>.<body>">`. */
function signatureMatches(
  body: string,
  header: string,
  secret: string,
): boolean {
  const parsed = SIGNATURE_RE.exec(header);
  if (!parsed) return false;
  const timestamp = Number(parsed[1]);
  // Replay window: an old capture must not be accepted, and a clock that runs
  // ahead of ours must not lock the endpoint out either.
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TOLERANCE_SECONDS) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest();
  const actual = Buffer.from(parsed[2]!, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Reads the raw body, checks the `sendsprite-signature` HMAC (and its ±5 min
 * timestamp window), and returns the parsed payload.
 *
 * @throws {WebhookVerificationError} when the header is missing, the
 * signature or timestamp does not check out, or the body is not JSON.
 */
export async function verifyWebhook<T = Record<string, unknown>>(
  req: Request,
  secret: string,
): Promise<WebhookPayload<T>> {
  const signature = req.headers.get(SIGNATURE_HEADER);
  if (!signature) {
    throw new WebhookVerificationError(`Missing ${SIGNATURE_HEADER} header.`);
  }
  const body = await req.text();
  if (!signatureMatches(body, signature, secret)) {
    throw new WebhookVerificationError("Invalid webhook signature.");
  }
  try {
    return JSON.parse(body) as WebhookPayload<T>;
  } catch {
    // Signed, so it came from Sendsprite — but it is not a payload we can use.
    throw new WebhookVerificationError("Webhook body is not valid JSON.");
  }
}

/** One handler per event type; every handler is awaited before responding. */
export type WebhookHandlers = Partial<
  Record<WebhookEventType, (event: WebhookPayload) => void | Promise<void>>
>;

export interface WebhookHandlerOptions {
  /** The endpoint's signing secret, shown once when the webhook is created. */
  secret: string;
  on: WebhookHandlers;
  /** Called for delivered events with no entry in `on`. */
  onUnhandled?: (event: WebhookPayload) => void | Promise<void>;
}

/**
 * Builds the `POST` route handler: 401 on a failed verification, 500 when a
 * handler throws (so Sendsprite retries the delivery with backoff), 200
 * otherwise — including for events nobody handles, which must not be retried.
 */
export function createWebhookHandler(
  opts: WebhookHandlerOptions,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    let event: WebhookPayload;
    try {
      event = await verifyWebhook(req, opts.secret);
    } catch (cause) {
      return Response.json(
        { error: cause instanceof Error ? cause.message : "invalid" },
        { status: 401 },
      );
    }
    try {
      const handler = opts.on[event.type] ?? opts.onUnhandled;
      await handler?.(event);
      return Response.json({
        received: true,
        id: req.headers.get(EVENT_ID_HEADER) ?? event.id,
      });
    } catch (cause) {
      console.error("[sendsprite webhook]", cause);
      return Response.json({ error: "handler failed" }, { status: 500 });
    }
  };
}
