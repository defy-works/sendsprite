/**
 * Webhook event types, payload shape and header/tolerance constants (spec
 * §8). The signing helpers live in `webhook-signature.ts` (exported from
 * `@sendsprite/shared/node`) because they need `node:crypto`.
 */

/**
 * Every event type a webhook may subscribe to.
 *
 * ## `data` names its object, always
 *
 * `email.*` carries `data.email` plus `data.event`, `domain.*` carries
 * `data.domain`, `contact.*` carries `data.contact` and `campaign.*` carries
 * `data.campaign` — each the same public object the REST API returns. A
 * payload that fanned its fields out at the top level instead would force
 * every subscriber to special-case that one event; Phase 6 changed the
 * contact payload for exactly that reason, and nothing added here reopens it.
 *
 * ## `campaign.sent` is not `campaign.completed`
 *
 * The distinction is the one that generates support threads, so it is stated
 * here as well as in the docs page:
 *
 * - **`campaign.sent`** — every recipient has been **queued**. Nobody has
 *   necessarily received anything yet; the delivery window has only just
 *   begun. An automation that reads this as "delivered" is wrong by the whole
 *   of it, and will only find out from its own users.
 * - **`campaign.completed`** — every message the campaign queued has reached
 *   a terminal state (delivered, bounced or failed). This is the one to wait
 *   on before reading a campaign's stats, and its payload carries the final
 *   `counts`.
 *
 * Both fire exactly once per campaign; a cancelled campaign fires neither,
 * because it never finished queueing.
 */
export const WEBHOOK_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.failed",
  "contact.created",
  "contact.updated",
  "contact.unsubscribed",
  "contact.resubscribed",
  "domain.verified",
  "domain.failed",
  "campaign.sent",
  "campaign.completed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookPayload<T = Record<string, unknown>> {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  data: T;
}

export const SIGNATURE_HEADER = "sendsprite-signature";
export const EVENT_ID_HEADER = "sendsprite-event-id";
export const SIGNATURE_TOLERANCE_SECONDS = 300;
