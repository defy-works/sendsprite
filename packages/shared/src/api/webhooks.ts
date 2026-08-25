/**
 * Webhook event types, payload shape and signature helpers (spec §8).
 *
 * NOTE: this module imports `node:crypto`. It is meant for the server and the
 * Node SDK entry (`sendsprite/next`); browser bundles must not import it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

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

const digest = (timestamp: number, body: string, secret: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

/** `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`. */
export function signWebhook(
  body: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},v1=${digest(timestamp, body, secret)}`;
}

export function verifyWebhookSignature(
  body: string,
  header: string,
  secret: string,
  opts: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header ?? "");
  if (!m) return false;
  const t = Number(m[1]);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (
    Math.abs(now - t) > (opts.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)
  )
    return false;
  const a = Buffer.from(m[2]!, "hex");
  const b = Buffer.from(digest(t, body, secret), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
