import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { and, desc, eq, lte } from "drizzle-orm";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";
import {
  can,
  newId,
  signWebhook,
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
  type WebhookPayload,
} from "@sendsprite/shared";
import { db } from "@/db";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { getCipher } from "@/lib/crypto";
import { recordAudit } from "@/lib/audit";
import { notifyTeam } from "@/lib/notify";
import { isPublicHttpUrl, isPublicIp } from "@/lib/url-safety";
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
/** Excerpt (and terminal verdict) for a target whose DNS answer is private. */
export const PRIVATE_TARGET = "target resolves to a private address";
/** Bytes of the response body kept as `responseExcerpt` (and read at all). */
export const EXCERPT_LEN = 500;
/** Event type of the synthetic delivery `sendTestEvent` produces. */
const TEST_EVENT_TYPE: WebhookEventType = "email.delivered";
const QUEUE = "webhook.deliver";

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

// https is required in production; dev/test may point at a local http
// listener. Private targets are rejected everywhere (SSRF: the worker would
// otherwise POST signed payloads at anything reachable from its network).
const url = z
  .string()
  .max(2048, "URL is too long.")
  .refine(
    (u) =>
      isPublicHttpUrl(u, { httpsOnly: process.env.NODE_ENV === "production" }),
    "Webhook URL must be a public https address",
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

/**
 * The delivery queue is `exclusive`, so one job per delivery id can be
 * queued/active at a time: a Replay while a retry is queued is deduped
 * instead of producing two concurrent attempts. `deliver()` additionally
 * skips rows already `delivered`.
 *
 * Only fan-out, Replay and the retry sweep call this — never `deliver()`
 * itself: while a job is `active` its key is taken and a self-enqueued
 * retry would be dropped by that same index (see webhook-deliver.ts).
 */
const enqueueDelivery = (enqueue: Enqueue, deliveryId: string) =>
  enqueue(QUEUE, { deliveryId }, { singletonKey: deliveryId });

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

/**
 * Inserts the pending delivery row with `nextRetryAt = now`, then enqueues
 * it. The retry sweep therefore also covers a first job that was lost
 * (dropped, expired, never landed): the row is due at once and the
 * exclusive `singletonKey` dedups the sweep's send against a first job that
 * is still queued/active. If the enqueue itself throws (pg-boss down) the
 * row is marked `failed` (`could not enqueue`); Replay can retry it.
 */
async function createDelivery(
  hook: Pick<Webhook, "id" | "teamId">,
  payload: WebhookPayload,
  deps: { enqueue: Enqueue },
): Promise<string> {
  const id = newId("whd");
  await db()
    .insert(webhookDeliveries)
    .values({
      id,
      webhookId: hook.id,
      teamId: hook.teamId,
      eventId: payload.id,
      eventType: payload.type,
      payload: payload as unknown as Record<string, unknown>,
      nextRetryAt: new Date(),
    });
  try {
    await enqueueDelivery(deps.enqueue, id);
  } catch (e) {
    console.error(`[webhooks] enqueue failed for ${id}:`, e);
    await db()
      .update(webhookDeliveries)
      .set({ status: "failed", responseExcerpt: "could not enqueue" })
      .where(eq(webhookDeliveries.id, id));
  }
  return id;
}

/**
 * Creates a pending delivery per enabled webhook subscribed to `type` and
 * enqueues each. `createdAt` is the event's own time (defaults to now).
 * Returns the delivery ids (including any marked failed at enqueue).
 */
export async function fanOutEvent(
  teamId: string,
  type: WebhookEventType,
  eventId: string,
  data: Record<string, unknown>,
  deps: { enqueue: Enqueue; createdAt?: Date },
): Promise<string[]> {
  const hooks = (await listWebhooks(teamId)).filter(
    (w) => w.enabled && w.events.includes(type),
  );
  const payload: WebhookPayload = {
    id: eventId,
    type,
    createdAt: (deps.createdAt ?? new Date()).toISOString(),
    data,
  };
  const ids: string[] = [];
  for (const w of hooks) ids.push(await createDelivery(w, payload, deps));
  return ids;
}

/**
 * At most EXCERPT_LEN bytes of the body, then the stream is cancelled so a
 * misbehaving endpoint cannot make the worker download an unbounded reply.
 */
async function readExcerpt(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text().catch(() => "")).slice(0, EXCERPT_LEN);
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < EXCERPT_LEN) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
    }
  } catch {
    // A truncated body is still an excerpt.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder()
    .decode(Buffer.concat(chunks).subarray(0, EXCERPT_LEN))
    .slice(0, EXCERPT_LEN);
}

type Resolved = { address: string; family: number }[];

/**
 * Resolves the target host and vets every answer with `isPublicIp`. The
 * URL check at create time is syntactic; a public name can resolve to a
 * private address (DNS rebinding, a hijacked CNAME), so the addresses are
 * checked right before connecting and the connection is pinned to them.
 */
async function resolveTarget(
  hostname: string,
): Promise<{ ok: true; addrs: Resolved } | { ok: false; error: string }> {
  // A bracketed IPv6 literal comes from `URL.hostname` with the brackets.
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  let addrs: Resolved;
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch (e) {
    return { ok: false, error: `dns: ${(e as Error).message}` };
  }
  if (addrs.length === 0) return { ok: false, error: "dns: no address" };
  if (!addrs.every((a) => isPublicIp(a.address)))
    return { ok: false, error: PRIVATE_TARGET };
  return { ok: true, addrs };
}

/**
 * A fetch whose connections go only to `addrs` (the vetted answers) while
 * TLS still verifies the hostname: undici's `connect.lookup` replaces the
 * resolver, not the host. undici's own `fetch` is used because Bun's global
 * fetch ignores `dispatcher`.
 */
function pinnedFetch(addrs: Resolved): FetchLike {
  const dispatcher = new Agent({
    connect: {
      lookup: (_host, opts, cb) => {
        const first = addrs[0]!;
        if (opts.all) cb(null, addrs);
        else cb(null, first.address, first.family);
      },
    },
  });
  return (url, init) =>
    undiciFetch(url, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    }).finally(() => void dispatcher.close()) as unknown as Promise<Response>;
}

/**
 * One delivery attempt. Never throws on the HTTP side: a non-2xx (redirects
 * are not followed and count as failures), a timeout (10 s) or a network
 * error sets `nextRetryAt` per RETRY_SCHEDULE_S (the once-a-minute sweep
 * enqueues it when due), and the sixth failure marks the delivery
 * `exhausted`. Before connecting the host is resolved and every address
 * vetted (`resolveTarget`); a private answer is terminal — the attempt is
 * recorded with `PRIVATE_TARGET` and the delivery marked `exhausted` with
 * no retry — and the connection is pinned to the vetted addresses. A
 * webhook failing continuously for 24 h is disabled. Returns the delivery
 * row after the attempt, or null when the delivery is gone or its webhook
 * is disabled.
 */
export async function deliver(
  deliveryId: string,
  deps: { fetch?: FetchLike; enqueue: Enqueue; now?: Date },
): Promise<WebhookDelivery | null> {
  const now = deps.now ?? new Date();
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
  let terminal = false;
  const target = await resolveTarget(new URL(w.url).hostname);
  if (!target.ok) {
    excerpt = target.error;
    terminal = target.error === PRIVATE_TARGET;
  }
  const f = deps.fetch ?? (target.ok ? pinnedFetch(target.addrs) : null);
  if (target.ok && f)
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
        // A redirect could re-point the signed POST at a host that never
        // passed URL validation; the customer can update the endpoint instead.
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      statusCode = res.status;
      excerpt =
        res.status >= 300 && res.status < 400
          ? "redirect not followed"
          : await readExcerpt(res);
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
    const delay = terminal ? undefined : RETRY_SCHEDULE_S[attempt - 1];
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
    {
      id: newId("evt"),
      type: TEST_EVENT_TYPE,
      createdAt: new Date().toISOString(),
      data: { test: true },
    },
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

/** Ids of pending deliveries whose retry is due at `now` (oldest first). */
export const listDueRetries = async (now: Date): Promise<string[]> =>
  (
    await db()
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.status, "pending"),
          lte(webhookDeliveries.nextRetryAt, now),
        ),
      )
      .orderBy(webhookDeliveries.nextRetryAt)
  ).map((r) => r.id);

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

/**
 * Restarts the retry series from attempt 0 and enqueues it right away.
 * `nextRetryAt` is set to now as well, so if the enqueue is deduped against
 * a job that is still queued or active, the sweep picks the row up within
 * a minute instead of it waiting out the old schedule.
 */
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
      nextRetryAt: new Date(),
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
  await enqueueDelivery(deps.enqueue, deliveryId);
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
