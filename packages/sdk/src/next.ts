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
// The signature check is the server's own `verifyWebhookSignature`, imported
// rather than re-implemented: a second copy of the scheme could drift, and the
// way it fails is "forged webhooks verify as genuine". Both modules are
// zod-free leaves of `@sendsprite/shared` (constants plus `node:crypto`), so
// tsup inlines them without pulling the package's schema barrel in.
import { verifyWebhookSignature } from "@sendsprite/shared/webhook-signature";
import { EVENT_ID_HEADER, SIGNATURE_HEADER } from "@sendsprite/shared/webhooks";
import type { WebhookEventType, WebhookPayload } from "./types";

export type { WebhookEventType, WebhookPayload };

/** Thrown when a request is not a genuine, fresh Sendsprite delivery. */
export class WebhookVerificationError extends Error {
  override readonly name = "WebhookVerificationError";
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
  if (!verifyWebhookSignature(body, signature, secret)) {
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
