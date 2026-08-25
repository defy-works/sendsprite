import { randomBytes } from "node:crypto";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { and, desc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import {
  can,
  newId,
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
  WebhookEvents,
  type PageQuery,
  type WebhookEventType,
  type WebhookPayload,
} from "@sendsprite/shared";
import { signWebhook } from "@sendsprite/shared/node";
import { db } from "@/db";
import { keysetPage, type Page } from "@/db/keyset";
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

// The public contract (`CreateWebhookInput` in @sendsprite/shared) is https
// only; the server's own `url` check differs on purpose: https is required in
// production but dev/test may point at a local http listener, and private
// targets are rejected everywhere (SSRF: the worker would otherwise POST
// signed payloads at anything reachable from its network).
const url = z
  .string()
  .trim()
  .max(2048, "URL is too long.")
  .refine(
    (u) =>
      isPublicHttpUrl(u, { httpsOnly: process.env.NODE_ENV === "production" }),
    "Webhook URL must be a public https address",
  );
const createInput = z.object({ url, events: WebhookEvents });
const updateInput = z
  .object({ url, events: WebhookEvents, enabled: z.boolean() })
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

/**
 * REST page, newest first. Keyset paging on `(created_at, id)` (cursor from `@/lib/cursor`).
 */
export const listWebhooksPage = (
  teamId: string,
  q: PageQuery,
): Promise<Result<Page<Webhook>>> =>
  keysetPage(webhooks, q, eq(webhooks.teamId, teamId));

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
 * Response bytes buffered before the connection is torn down. Well above
 * EXCERPT_LEN, so `readExcerpt` still sees everything it would keep, and
 * bounded, so an endpoint that streams forever cannot fill the worker's
 * memory (the old undici path relied on cancelling the body stream).
 */
export const MAX_RESPONSE_BYTES = 8 * 1024;

/** Statuses the `Response` constructor refuses to pair with a body. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

/** `node:http` hands back `string | string[] | undefined` per header. */
function toHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    // A hostile endpoint should cost us a failed attempt at worst, not an
    // exception: skip anything the Headers API rejects.
    try {
      if (Array.isArray(value)) for (const v of value) headers.append(name, v);
      else headers.set(name, value);
    } catch {
      // Unrepresentable header; the excerpt does not need it.
    }
  }
  return headers;
}

/**
 * A fetch whose connections go only to `addrs` (the vetted answers) while
 * TLS still verifies the hostname.
 *
 * `node:http`/`node:https` take a `lookup` that replaces DNS resolution for
 * this request only; `host` stays the *hostname*, so certificate validation
 * (and the `Host` header) are entirely standard — connecting to the IP with
 * an overridden `servername` would not be. Both Bun and Node call `lookup`
 * with `all: true`, so the array form is the one that matters; the scalar
 * form is kept for contract completeness.
 *
 * This replaces undici, which Bun aliases to a builtin that ignores
 * `connect.lookup` — the pin was silently a no-op in the image, leaving the
 * TOCTOU window (DNS rebinding) that vetting the addresses is meant to close.
 *
 * Redirects are never followed: `node:http` does not follow them at all, so
 * a 3xx is returned as itself (`deliver` treats it as a failure).
 */
export function pinnedFetch(addrs: Resolved): FetchLike {
  const lookup: LookupFunction = (_hostname, opts, cb) => {
    const first = addrs[0]!;
    if (opts.all) cb(null, addrs);
    else cb(null, first.address, first.family);
  };
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const secure = u.protocol === "https:";
      // `URL.hostname` brackets an IPv6 literal; `host` wants it bare (Node
      // re-brackets it for the `Host` header itself).
      const host = u.hostname.replace(/^\[(.*)\]$/, "$1");
      const headers = new Headers(init?.headers);
      // Node sends no `accept-encoding` and does not decompress, so ask for
      // none: a compressed reply would make `responseExcerpt` binary noise.
      if (!headers.has("accept-encoding"))
        headers.set("accept-encoding", "identity");
      const body = init?.body;
      if (body !== undefined && body !== null && typeof body !== "string") {
        reject(new Error("pinnedFetch supports a string body only"));
        return;
      }
      if (typeof body === "string" && !headers.has("content-length"))
        headers.set("content-length", String(Buffer.byteLength(body)));

      // The rejection reason is stored verbatim as `responseExcerpt`, so it
      // has to read as a diagnosis on its own.
      const signal = init?.signal ?? undefined;
      const aborted = () => {
        const reason: unknown = signal?.reason;
        return new Error(
          reason instanceof Error
            ? `request aborted: ${reason.message}`
            : "request aborted",
        );
      };
      if (signal?.aborted) {
        reject(aborted());
        return;
      }

      let settled = false;
      // Declared (hoisted) so `cleanup` can name it before `req` exists.
      function onAbort() {
        // `destroy(err)` surfaces on the request's `error` event, which is
        // already wired to reject.
        req.destroy(aborted());
      }
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      };
      const succeed = (res: Response) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      };

      const req = (secure ? https.request : http.request)({
        host,
        port: u.port || (secure ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: init?.method ?? "GET",
        headers: Object.fromEntries(headers),
        lookup,
        // No shared agent: the global one pools sockets by host:port, so a
        // kept-alive connection could outlive the answers it was pinned to.
        // Every delivery gets its own connection.
        agent: false,
      });

      req.on("error", fail);
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        const finish = () => {
          const buf = Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES);
          succeed(
            new Response(
              NULL_BODY_STATUS.has(res.statusCode ?? 0) ? null : buf,
              {
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? "",
                headers: toHeaders(res.headers),
              },
            ),
          );
          // Whatever is still in flight is not wanted.
          req.destroy();
        };
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          n += chunk.length;
          if (n >= MAX_RESPONSE_BYTES) finish();
        });
        res.on("end", finish);
        res.on("error", fail);
      });

      if (typeof body === "string") req.end(body);
      else req.end();
    });
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
      // A 3xx comes back as the 3xx itself (`pinnedFetch` never follows
      // one, nor do the tests' injected fetches); a spec-style
      // `opaqueredirect` (status 0) from a global fetch is handled too.
      const redirected =
        res.type === "opaqueredirect" ||
        (res.status >= 300 && res.status < 400);
      statusCode = res.status;
      excerpt = redirected ? "redirect not followed" : await readExcerpt(res);
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
    return {
      ok: false,
      code: "conflict",
      error: "Enable the webhook before sending a test.",
    };
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
