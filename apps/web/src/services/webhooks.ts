import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  can,
  newId,
  signWebhook,
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPES,
} from "@sendsprite/shared";
import { db } from "@/db";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { getCipher } from "@/lib/crypto";
import { recordAudit } from "@/lib/audit";
import { notifyTeam } from "@/lib/notify";
import type { Result } from "@/lib/result";
import type { FetchLike } from "@/lib/cloudflare/client";
import type { TeamActor } from "./team";
import type { Enqueue } from "./domains";

export type Webhook = typeof webhooks.$inferSelect;
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

/** Seconds to wait before retrying, indexed by the attempt that just failed (1..5). */
export const RETRY_SCHEDULE_S = [60, 300, 1800, 7200, 28800] as const;
/** A webhook that has failed continuously this long is switched off. */
export const DISABLE_AFTER_MS = 24 * 3600 * 1000;
export const DISABLED_REASON = "Disabled after 24 hours of failed deliveries.";
const TIMEOUT_MS = 10_000;
const EXCERPT_LEN = 500;
/** Event type of the synthetic delivery `sendTestEvent` produces. */
const TEST_EVENT_TYPE = "email.delivered";

const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You don't have permission to do that.",
};
const NOT_FOUND: Result<never> = {
  ok: false,
  code: "not_found",
  error: "Webhook not found.",
};

const url = z
  .url("Enter a valid URL.")
  .refine(
    (u) => u.startsWith("https://") || process.env.NODE_ENV !== "production",
    "URL must use https.",
  );
const events = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .min(1, "Pick at least one event.");
const createInput = z.object({ url, events });
const updateInput = z
  .object({ url, events, enabled: z.boolean() })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "Nothing to update.");

const invalid = (e: z.ZodError): Result<never> => ({
  ok: false,
  error: e.issues[0]?.message ?? "Invalid input.",
});
const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

/** REST shape: never the secret, not even encrypted. */
export const publicWebhook = (w: Webhook) => ({
  id: w.id,
  url: w.url,
  events: w.events,
  enabled: w.enabled,
  disabledReason: w.disabledReason,
  failingSince: w.failingSince,
  createdAt: w.createdAt,
  updatedAt: w.updatedAt,
});

/** Newest first. */
export const listWebhooks = (teamId: string): Promise<Webhook[]> =>
  db()
    .select()
    .from(webhooks)
    .where(eq(webhooks.teamId, teamId))
    .orderBy(desc(webhooks.createdAt));

export async function getWebhook(
  teamId: string,
  id: string,
): Promise<Webhook | null> {
  const [w] = await db()
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.teamId, teamId)));
  return w ?? null;
}

/** The secret is returned exactly once; only its ciphertext is stored. */
export async function createWebhook(
  actor: TeamActor,
  raw: unknown,
): Promise<Result<{ id: string; secret: string }>> {
  if (!can(actor.role, "webhooks.manage")) return DENIED;
  const p = createInput.safeParse(raw);
  if (!p.success) return invalid(p.error);
  const id = newId("wh");
  const secret = newSecret();
  await db()
    .insert(webhooks)
    .values({
      id,
      teamId: actor.teamId,
      url: p.data.url,
      secretEnc: getCipher().encrypt(secret),
      events: p.data.events,
    });
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "webhooks.create",
    targetType: "webhook",
    targetId: id,
    diff: { url: { to: p.data.url }, events: { to: p.data.events } },
  });
  return { ok: true, data: { id, secret } };
}

/** Re-enabling clears the failure state so the 24 h clock starts afresh. */
export async function updateWebhook(
  actor: TeamActor,
  id: string,
  raw: unknown,
): Promise<Result<Webhook>> {
  if (!can(actor.role, "webhooks.manage")) return DENIED;
  const p = updateInput.safeParse(raw);
  if (!p.success) return invalid(p.error);
  const before = await getWebhook(actor.teamId, id);
  if (!before) return NOT_FOUND;
  const { url, events, enabled } = p.data;
  const [after] = await db()
    .update(webhooks)
    .set({
      ...(url !== undefined && { url }),
      ...(events !== undefined && { events }),
      ...(enabled !== undefined && { enabled }),
      ...(enabled && { failingSince: null, disabledReason: null }),
    })
    .where(eq(webhooks.id, id))
    .returning();
  if (!after) return NOT_FOUND;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "webhooks.update",
    targetType: "webhook",
    targetId: id,
    diff: {
      ...(url !== undefined && { url: { from: before.url, to: url } }),
      ...(events !== undefined && {
        events: { from: before.events, to: events },
      }),
      ...(enabled !== undefined && {
        enabled: { from: before.enabled, to: enabled },
      }),
    },
  });
  return { ok: true, data: after };
}

/** Deliveries go with it (FK cascade). */
export async function deleteWebhook(
  actor: TeamActor,
  id: string,
): Promise<Result> {
  if (!can(actor.role, "webhooks.manage")) return DENIED;
  const [row] = await db()
    .delete(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.teamId, actor.teamId)))
    .returning({ id: webhooks.id });
  if (!row) return NOT_FOUND;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "webhooks.delete",
    targetType: "webhook",
    targetId: id,
  });
  return { ok: true, data: undefined };
}

/** Pending retries sign with the new secret from their next attempt on. */
export async function rotateSecret(
  actor: TeamActor,
  id: string,
): Promise<Result<{ secret: string }>> {
  if (!can(actor.role, "webhooks.manage")) return DENIED;
  const secret = newSecret();
  const [row] = await db()
    .update(webhooks)
    .set({ secretEnc: getCipher().encrypt(secret) })
    .where(and(eq(webhooks.id, id), eq(webhooks.teamId, actor.teamId)))
    .returning({ id: webhooks.id });
  if (!row) return NOT_FOUND;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "webhooks.rotateSecret",
    targetType: "webhook",
    targetId: id,
  });
  return { ok: true, data: { secret } };
}

async function createDelivery(
  hook: Pick<Webhook, "id" | "teamId">,
  type: string,
  eventId: string,
  data: Record<string, unknown>,
  deps: { enqueue: Enqueue },
): Promise<string> {
  const id = newId("whd");
  await db()
    .insert(webhookDeliveries)
    .values({
      id,
      webhookId: hook.id,
      teamId: hook.teamId,
      eventId,
      eventType: type,
      payload: { id: eventId, type, createdAt: new Date().toISOString(), data },
    });
  await deps.enqueue("webhook.deliver", { deliveryId: id });
  return id;
}

/**
 * Creates a pending delivery per enabled webhook subscribed to `type` and
 * enqueues each. Returns the delivery ids.
 */
export async function fanOutEvent(
  teamId: string,
  type: string,
  eventId: string,
  data: Record<string, unknown>,
  deps: { enqueue: Enqueue },
): Promise<string[]> {
  const hooks = (await listWebhooks(teamId)).filter(
    (w) => w.enabled && w.events.includes(type),
  );
  const ids: string[] = [];
  for (const w of hooks)
    ids.push(await createDelivery(w, type, eventId, data, deps));
  return ids;
}

/**
 * One delivery attempt. Never throws on the HTTP side: a non-2xx, a timeout
 * (10 s) or a network error schedules the next attempt per RETRY_SCHEDULE_S,
 * and the sixth failure marks the delivery `exhausted`. A webhook failing
 * continuously for 24 h is disabled. Returns the delivery row after the
 * attempt, or null when the delivery is gone or its webhook is disabled.
 */
export async function deliver(
  deliveryId: string,
  deps: { fetch?: FetchLike; enqueue: Enqueue; now?: Date },
): Promise<WebhookDelivery | null> {
  const now = deps.now ?? new Date();
  const f = deps.fetch ?? fetch;
  const [d] = await db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!d || d.status === "delivered") return d ?? null;
  const [w] = await db()
    .select()
    .from(webhooks)
    .where(eq(webhooks.id, d.webhookId));
  if (!w || !w.enabled) {
    await db()
      .update(webhookDeliveries)
      .set({
        status: "failed",
        responseExcerpt: "webhook disabled",
        nextRetryAt: null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    return null;
  }
  const body = JSON.stringify(d.payload);
  const secret = getCipher().decrypt(w.secretEnc);
  const attempt = d.attempt + 1;
  let statusCode: number | null = null;
  let excerpt = "";
  try {
    const res = await f(w.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Sendsprite-Webhooks/1",
        [SIGNATURE_HEADER]: signWebhook(
          body,
          secret,
          Math.floor(now.getTime() / 1000),
        ),
        [EVENT_ID_HEADER]: d.eventId,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    statusCode = res.status;
    excerpt = (await res.text().catch(() => "")).slice(0, EXCERPT_LEN);
  } catch (e) {
    excerpt = (e as Error).message.slice(0, EXCERPT_LEN);
  }
  const okResp = statusCode !== null && statusCode >= 200 && statusCode < 300;
  if (okResp) {
    await db()
      .update(webhookDeliveries)
      .set({
        attempt,
        status: "delivered",
        statusCode,
        responseExcerpt: excerpt,
        deliveredAt: now,
        nextRetryAt: null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    if (w.failingSince)
      await db()
        .update(webhooks)
        .set({ failingSince: null })
        .where(eq(webhooks.id, w.id));
  } else {
    const delay = RETRY_SCHEDULE_S[attempt - 1];
    const failingSince = w.failingSince ?? now;
    if (!w.failingSince)
      await db()
        .update(webhooks)
        .set({ failingSince })
        .where(eq(webhooks.id, w.id));
    if (delay !== undefined) {
      await db()
        .update(webhookDeliveries)
        .set({
          attempt,
          status: "pending",
          statusCode,
          responseExcerpt: excerpt,
          nextRetryAt: new Date(now.getTime() + delay * 1000),
        })
        .where(eq(webhookDeliveries.id, deliveryId));
      await deps.enqueue(
        "webhook.deliver",
        { deliveryId },
        { startAfter: delay },
      );
    } else
      await db()
        .update(webhookDeliveries)
        .set({
          attempt,
          status: "exhausted",
          statusCode,
          responseExcerpt: excerpt,
          nextRetryAt: null,
        })
        .where(eq(webhookDeliveries.id, deliveryId));
    if (now.getTime() - failingSince.getTime() >= DISABLE_AFTER_MS)
      await db()
        .update(webhooks)
        .set({ enabled: false, disabledReason: DISABLED_REASON })
        .where(eq(webhooks.id, w.id));
  }
  await notifyTeam(d.teamId, { type: "webhook", id: d.webhookId });
  const [after] = await db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId));
  return after ?? null;
}

/**
 * Queues one synthetic `email.delivered` delivery to this webhook only,
 * regardless of its subscriptions, so an endpoint can be checked end to end.
 */
export async function sendTestEvent(
  actor: TeamActor,
  id: string,
  deps: { enqueue: Enqueue },
): Promise<Result<{ deliveryId: string }>> {
  if (!can(actor.role, "webhooks.manage")) return DENIED;
  const w = await getWebhook(actor.teamId, id);
  if (!w) return NOT_FOUND;
  if (!w.enabled)
    return { ok: false, error: "Enable the webhook before sending a test." };
  const deliveryId = await createDelivery(
    w,
    TEST_EVENT_TYPE,
    newId("evt"),
    { test: true },
    deps,
  );
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "webhooks.test",
    targetType: "webhook",
    targetId: id,
  });
  return { ok: true, data: { deliveryId } };
}

/** Newest first. */
export const listDeliveries = (
  teamId: string,
  webhookId: string,
  limit = 50,
): Promise<WebhookDelivery[]> =>
  db()
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.teamId, teamId),
        eq(webhookDeliveries.webhookId, webhookId),
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);

/** Restarts the retry series from attempt 0 and enqueues it right away. */
export async function replayDelivery(
  actor: TeamActor,
  deliveryId: string,
  deps: { enqueue: Enqueue },
): Promise<Result> {
  if (!can(actor.role, "webhooks.manage")) return DENIED;
  const [row] = await db()
    .update(webhookDeliveries)
    .set({
      attempt: 0,
      status: "pending",
      statusCode: null,
      responseExcerpt: null,
      nextRetryAt: null,
      deliveredAt: null,
    })
    .where(
      and(
        eq(webhookDeliveries.id, deliveryId),
        eq(webhookDeliveries.teamId, actor.teamId),
      ),
    )
    .returning({ webhookId: webhookDeliveries.webhookId });
  if (!row)
    return { ok: false, code: "not_found", error: "Delivery not found." };
  await deps.enqueue("webhook.deliver", { deliveryId });
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "webhooks.replay",
    targetType: "webhookDelivery",
    targetId: deliveryId,
  });
  return { ok: true, data: undefined };
}
