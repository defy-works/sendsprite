/**
 * Webhook event types, payload shape and header/tolerance constants (spec
 * §8). The signing helpers live in `webhook-signature.ts` (exported from
 * `@sendsprite/shared/node`) because they need `node:crypto`.
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
