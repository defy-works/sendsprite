import { fail, ok } from "@/lib/api-response";
import { getBillingProvider, handleProviderEvent } from "@/services/billing";
import { billingEnabled } from "@/services/billing/config";

export const dynamic = "force-dynamic";

/**
 * Provider webhooks are a few KB. This endpoint is reachable by anyone before
 * any signature has been checked, so it carries its own cap rather than
 * inheriting the 25 MB one the email routes need for base64 attachments
 * (Phase 4 opener 21, closed for this route).
 */
const MAX_WEBHOOK_BYTES = 64 * 1024;

const tooLarge = () =>
  fail(
    "payload_too_large",
    `Request body must be at most ${MAX_WEBHOOK_BYTES} bytes.`,
  );

/**
 * `POST /api/billing/webhook` — the payment provider's endpoint.
 *
 * With `BILLING_ENABLED=false` this is a bare 404: a self-hosted instance
 * must not expose a live billing endpoint it has no use for, and a body-less
 * 404 is what a route that does not exist looks like.
 *
 * The status code is the only thing the provider reads, and it means exactly
 * one thing: *retry or not*. So **every verified delivery gets a 200**,
 * including one we deliberately do not apply — an unmodelled event type, an
 * unknown team, a stale payload, a redelivery we have already applied. A 4xx
 * on any of those would make the provider retry, on a schedule, something
 * that can never succeed. Non-2xx is reserved for the two cases a retry can
 * actually fix: a delivery we could not verify (403) and one we could not
 * process (500).
 *
 * Dedupe, ordering, transactionality and the audit trail all live in
 * `handleProviderEvent`, which is tested directly; this route is the body
 * cap, the enabled check and the status mapping.
 */
export async function POST(req: Request): Promise<Response> {
  if (!billingEnabled()) return new Response(null, { status: 404 });

  // Checked before reading so an oversized body is refused unbuffered. A
  // chunked request declares no length, hence the second check below.
  if (Number(req.headers.get("content-length")) > MAX_WEBHOOK_BYTES)
    return tooLarge();

  // The *raw* body, never re-serialised JSON: the signature covers the exact
  // bytes the provider sent, and nothing in the payload may be trusted — or
  // even read — before `verifyWebhook` has vouched for them.
  const body = await req.text();
  if (Buffer.byteLength(body) > MAX_WEBHOOK_BYTES) return tooLarge();

  try {
    const provider = await getBillingProvider();
    const r = await handleProviderEvent(provider, body, req.headers);
    if (r.status === 403)
      // The reason is a Standard-Webhooks-level fact ("bad signature",
      // "message timestamp too old"), not a secret, and it is the only thing
      // an operator debugging a misconfigured endpoint sees in the provider's
      // delivery log.
      return fail("forbidden", `Webhook verification failed: ${r.reason}`);
    return ok({
      received: true,
      applied: r.applied,
      ...(r.duplicate && { duplicate: true }),
      ...(r.reason && { reason: r.reason }),
    });
  } catch (e) {
    // A 500 makes the provider redeliver, which is right for a transient
    // fault: the delivery id keeps that retry idempotent, and a rolled-back
    // transaction has left the dedupe key free.
    console.error("[billing] webhook failed", e);
    return fail("internal_error", "Could not process the webhook delivery.");
  }
}
