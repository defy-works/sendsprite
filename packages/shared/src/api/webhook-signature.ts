/**
 * Webhook signature helpers (spec §8).
 *
 * NOTE: this module imports `node:crypto`. It is exported from
 * `@sendsprite/shared/node` only; the root barrel (and any browser bundle)
 * must not import it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { SIGNATURE_TOLERANCE_SECONDS } from "./webhooks";

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
