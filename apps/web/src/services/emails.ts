import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  BatchSendInput,
  SendEmailInput,
  newId,
  type ErrorCode,
} from "@sendsprite/shared";
import { db } from "@/db";
import type { Result } from "@/lib/result";
import {
  domains,
  emailAttachments,
  emails,
  teamSettings,
  type EmailSource,
} from "@/db/schema";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { domainOf, parseAddress } from "@/lib/email-address";
import { injectPixel, unwrapTracking, wrapLinks } from "@/lib/tracking";
import { loadEnv } from "@/env.schema";
import { Q } from "@/jobs/queues";
import { recordEvent } from "./email-events";
import { isSuppressed } from "./suppressions";
import { getTemplate, renderTemplateRow } from "./templates";
import { checkInstanceQuota, checkTeamCaps } from "./send-limits";
import type { Domain, Enqueue } from "./domains";

export interface SendContext {
  teamId: string;
  source: EmailSource;
  apiKeyId: string | null;
  actorUserId: string | null;
  /** A key restricted to one sending domain (`api_keys.domain_id`). */
  keyDomainId?: string | null;
  /**
   * The API key's permission; absent for dashboard sends (treated as
   * `full`). A `sending_only` key cannot override suppressions.
   */
  permission?: "full" | "sending_only";
}
export type EmailRow = typeof emails.$inferSelect;
export type SendFailure = {
  ok: false;
  code: ErrorCode;
  error: string;
  details?: unknown;
};
export type SendResult = { ok: true; data: EmailRow } | SendFailure;
/** `created: false` is an idempotent replay returning the earlier email. */
export type CreateResult =
  { ok: true; data: EmailRow; created: boolean } | SendFailure;

const fail = (
  code: ErrorCode,
  error: string,
  details?: unknown,
): SendFailure => ({ ok: false, code, error, details });

/** A send this close to "now" is queued immediately rather than scheduled. */
const SCHEDULE_THRESHOLD_MS = 5000;
const CANCELLABLE = ["queued", "scheduled"] as const;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Idempotency fingerprint: subject, the recipient set (order-insensitive)
 * and the body hashes. `subject + to` alone would let a retry with a
 * different body silently return the first email; bcc/cc are left out
 * because clients commonly vary them between retries (and `to` already
 * pins the message's identity).
 */
const fingerprint = (i: {
  subject: string;
  to: string[];
  html: string | null;
  text: string | null;
}) =>
  sha256(
    JSON.stringify([
      i.subject,
      [...i.to].sort(),
      sha256(i.html ?? ""),
      sha256(i.text ?? ""),
    ]),
  );

/**
 * Tracking rewrites are keyed by the email id, so the same html rendered
 * for the same id is byte-identical: that lets an idempotent retry be
 * compared against the stored (rewritten) body.
 */
function applyTracking(
  html: string | null,
  id: string,
  opts: { trackOpens: boolean; trackClicks: boolean },
): string | null {
  if (!html) return html;
  const env = loadEnv();
  let out = html;
  if (opts.trackClicks) out = wrapLinks(out, id, env.APP_URL, env.APP_SECRET);
  if (opts.trackOpens) out = injectPixel(out, id, env.APP_URL);
  return out;
}

/** Longest-suffix match of the from-address domain against the team's verified domains. */
export async function resolveSendingDomain(
  teamId: string,
  fromEmail: string,
): Promise<Domain | null> {
  const d = domainOf(fromEmail);
  const rows = await db()
    .select()
    .from(domains)
    .where(and(eq(domains.teamId, teamId), eq(domains.status, "verified")));
  return (
    rows
      .filter((r) => d === r.name || d.endsWith(`.${r.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}

/**
 * Provenance carried onto a new row without re-rendering.
 *
 * Only `resendEmail` supplies it: a resend copies the bytes of the original
 * message, so it must not run the template again, but the new row still came
 * from that template and the mail log has to say so.
 */
export interface TemplateProvenance {
  templateId: string | null;
  variables: Record<string, unknown> | null;
}

/**
 * Validate, resolve the sending domain, apply suppressions/caps/tracking,
 * store the row (+ attachment bytes) and enqueue `email.send`. Every
 * refusal is a typed `SendFailure`; only infrastructure errors throw.
 */
export async function createEmail(
  ctx: SendContext,
  raw: unknown,
  deps: { enqueue: Enqueue; now?: Date; provenance?: TemplateProvenance },
): Promise<CreateResult> {
  const parsed = SendEmailInput.safeParse(raw);
  if (!parsed.success)
    return fail(
      "validation_error",
      parsed.error.issues[0]?.message ?? "Invalid request.",
      parsed.error.issues,
    );
  const input = parsed.data;
  const now = deps.now ?? new Date();
  const from = parseAddress(input.from);
  if (!from) return fail("validation_error", "from is not a valid address.");
  const rcpt = (list: string[]) => list.map((s) => parseAddress(s)?.email);
  const to = rcpt(input.to);
  const cc = rcpt(input.cc);
  const bcc = rcpt(input.bcc);
  const replyTo = rcpt(input.replyTo);
  const isList = (l: (string | undefined)[]): l is string[] =>
    l.every((x) => x !== undefined);
  if (!isList(to) || !isList(cc) || !isList(bcc) || !isList(replyTo))
    return fail("validation_error", "A recipient address is invalid.");

  // Rendered here — *before* the idempotency lookup — so a replay's
  // fingerprint is computed over the same bytes the first send stored.
  // Rendering after the lookup would compare an unrendered request against a
  // rendered row and conflict on every honest retry; worse, once that was
  // papered over, a retry issued after the template changed would silently
  // return an email whose body no longer matches the request. The order is
  // the guarantee.
  // A resend hands these in: it copies the source row's bytes rather than
  // rendering again, and without them the log would claim a template-derived
  // email came from nowhere. The `input.template` branch below overwrites
  // both, so a real render always wins.
  let templateId: string | null = deps.provenance?.templateId ?? null;
  let variables: Record<string, unknown> | null =
    deps.provenance?.variables ?? null;
  // Trimmed so a whitespace-only subject counts as absent and the template's
  // own subject wins, rather than a blank header reaching the MIME message.
  let subject = input.subject?.trim() ?? "";
  let html = input.html ?? null;
  let text = input.text ?? null;
  if (input.template) {
    // Read here rather than inside `renderStoredTemplate` because the row's
    // id is stored beside the body: the email records the very row it was
    // rendered from. `renderTemplateRow` is the same seam the dashboard
    // preview and `POST /templates/:slug/render` go through, so a preview
    // cannot disagree with a send.
    const tpl = await getTemplate(ctx.teamId, input.template);
    if (!tpl)
      return fail(
        "validation_error",
        `Template "${input.template}" not found.`,
        { field: "template" },
      );
    const rendered = renderTemplateRow(tpl, input.variables ?? {});
    if (!rendered.ok)
      return fail("validation_error", rendered.error, rendered.details);
    templateId = tpl.id;
    variables = input.variables ?? {};
    // A request-level subject wins; otherwise the template's rendered one.
    subject = subject || rendered.data.subject;
    html = rendered.data.html;
    text = rendered.data.text;
  }
  // The schema's refine guarantees a subject on both paths; kept because this
  // is what reaches the MIME header and a silently empty one is worse than a
  // refusal.
  if (!subject) return fail("validation_error", "subject is required.");

  // Before the domain check: a retry after the domain was un-verified still
  // gets the email it already created.
  if (input.idempotencyKey) {
    const [existing] = await db()
      .select()
      .from(emails)
      .where(
        and(
          eq(emails.teamId, ctx.teamId),
          eq(emails.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) {
      // Tracking flags are not part of the fingerprint (lenient by design:
      // the stored row's flags are reused so the html compares equal).
      // A purged body can no longer be compared; subject + to decide then.
      const same = existing.bodyPurgedAt
        ? existing.subject === subject &&
          JSON.stringify([...existing.to].sort()) ===
            JSON.stringify([...to].sort())
        : fingerprint(existing) ===
          fingerprint({
            subject,
            to,
            html: applyTracking(html, existing.id, existing),
            text,
          });
      return same
        ? { ok: true, data: existing, created: false }
        : fail(
            "idempotency_conflict",
            "idempotencyKey was already used with a different payload.",
          );
    }
  }

  const domain = await resolveSendingDomain(ctx.teamId, from.email);
  if (!domain)
    return fail(
      "domain_not_verified",
      `No verified sending domain for ${from.email}.`,
    );
  if (ctx.keyDomainId && ctx.keyDomainId !== domain.id)
    return fail("forbidden", "This API key is restricted to another domain.");

  const sup = await isSuppressed(ctx.teamId, [...to, ...cc, ...bcc]);
  // Only `manual` entries can be overridden, and not by a sending-only key.
  const override =
    input.overrideSuppression === true && ctx.permission !== "sending_only";
  const blocking = sup.filter((s) => !(override && s.reason === "manual"));
  if (blocking.length)
    return fail(
      "suppressed_recipient",
      `Recipient is suppressed (${blocking[0]!.reason}): ${blocking[0]!.email}`,
      blocking,
    );
  const caps = await checkTeamCaps(ctx.teamId, 1, now);
  if (!caps.ok) return fail(caps.code, caps.message);
  const quota = await checkInstanceQuota(1, now);
  if (!quota.ok) return fail(quota.code, quota.message);

  const [ts] = await db()
    .select()
    .from(teamSettings)
    .where(eq(teamSettings.teamId, ctx.teamId));
  const tracking = {
    trackOpens: input.trackOpens ?? ts?.trackOpens ?? true,
    trackClicks: input.trackClicks ?? ts?.trackClicks ?? true,
  };
  const id = newId("em");
  const trackedHtml = applyTracking(html, id, tracking);
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  const status =
    scheduledAt && scheduledAt.getTime() > now.getTime() + SCHEDULE_THRESHOLD_MS
      ? "scheduled"
      : "queued";
  // The shared schema already stripped whitespace and checked base64.
  const attachments = input.attachments.map((a) => ({
    id: newId("att"),
    filename: a.filename,
    contentType: a.contentType ?? "application/octet-stream",
    bytes: Buffer.from(a.content, "base64"),
  }));
  const attachmentsMeta = attachments.map(({ bytes, ...m }) => ({
    ...m,
    size: bytes.length,
  }));

  let row: EmailRow | undefined;
  try {
    row = await db().transaction(async (tx) => {
      const [r] = await tx
        .insert(emails)
        .values({
          id,
          teamId: ctx.teamId,
          apiKeyId: ctx.apiKeyId,
          domainId: domain.id,
          from: input.from,
          fromEmail: from.email,
          to,
          cc,
          bcc,
          replyTo,
          subject,
          html: trackedHtml,
          text,
          templateId,
          variables,
          headers: input.headers,
          tags: input.tags,
          attachmentsMeta,
          ...tracking,
          status,
          source: ctx.source,
          idempotencyKey: input.idempotencyKey ?? null,
          scheduledAt,
        })
        .returning();
      if (attachments.length)
        await tx.insert(emailAttachments).values(
          attachments.map((a, i) => ({
            ...a,
            emailId: id,
            size: attachmentsMeta[i]!.size,
          })),
        );
      return r;
    });
  } catch (e) {
    // Two concurrent requests with the same key: the unique index decides.
    if (pgCode(e) === "23505")
      return fail("idempotency_conflict", "idempotencyKey was already used.");
    throw e;
  }
  if (!row) throw new Error("emails insert returned no row");

  await recordEvent({
    emailId: id,
    teamId: ctx.teamId,
    type: "queued",
    dedupeKey: `local:${id}:queued`,
    payload: { source: ctx.source, status },
  });
  // The row is committed; a queue failure (pg-boss down) must not fail
  // the request. The `email.queued-sweep` cron re-sends jobs for due rows
  // untouched for 5 minutes (`sweepQueuedEmails`).
  try {
    await deps.enqueue(
      Q.emailSend,
      { emailId: id },
      scheduledAt ? delayOpts(scheduledAt, now) : undefined,
    );
  } catch (e) {
    console.error(
      `[emails] enqueue failed for ${id}; the queued sweep will pick it up:`,
      e,
    );
  }
  return { ok: true, data: row, created: true };
}

const delayOpts = (at: Date, now: Date) => {
  const s = Math.max(0, Math.round((at.getTime() - now.getTime()) / 1000));
  return s > 0 ? { startAfter: s } : undefined;
};

/** Postgres SQLSTATE, on the driver error or (drizzle) its `cause`. */
const pgCode = (e: unknown): string | undefined => {
  const o = e as { code?: string; cause?: { code?: string } } | null;
  return o?.code ?? o?.cause?.code;
};

/**
 * Items are created one by one with no outer transaction: on the first
 * failure the earlier items are already queued and stay so. The failure
 * carries `details.index` so the caller can tell which item stopped the
 * batch (the Phase 4 SDK surfaces the partial success).
 *
 * Memory: the whole batch is parsed up front, so 100 items x 10 MB of
 * base64 attachments is the worst case; the REST layer must cap the request
 * body (Task 12) rather than rely on this function to stream.
 */
export async function createBatch(
  ctx: SendContext,
  raw: unknown,
  deps: { enqueue: Enqueue; now?: Date },
): Promise<{ ok: true; data: { id: string }[] } | SendFailure> {
  const parsed = BatchSendInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(
      "validation_error",
      issue?.message ?? "Invalid batch.",
      parsed.error.issues,
    );
  }
  const data: { id: string }[] = [];
  for (const [index, item] of parsed.data.entries()) {
    const r = await createEmail(ctx, item, deps);
    if (!r.ok)
      return fail(r.code, `Item ${index}: ${r.error}`, {
        index,
        ...(r.details && typeof r.details === "object"
          ? { cause: r.details }
          : {}),
      });
    data.push({ id: r.data.id });
  }
  return { ok: true, data };
}

export const getEmail = (
  teamId: string,
  id: string,
): Promise<EmailRow | null> =>
  db()
    .select()
    .from(emails)
    .where(and(eq(emails.id, id), eq(emails.teamId, teamId)))
    .then((r) => r[0] ?? null);

export interface ListEmailsQuery {
  limit: number;
  cursor?: string;
  status?: EmailRow["status"];
  /** Exact (normalised) recipient in `to`. */
  to?: string;
  domainId?: string;
  /** `key:value`; a value may itself contain `:`. */
  tag?: string;
}
export interface EmailPage {
  data: EmailRow[];
  /** Opaque; pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

/** Newest first; keyset pagination on `(created_at desc, id desc)`. */
export async function listEmails(
  teamId: string,
  q: ListEmailsQuery,
): Promise<Result<EmailPage>> {
  const cur = q.cursor ? decodeCursor(q.cursor) : null;
  if (q.cursor && !cur) return { ok: false, error: "Invalid cursor." };
  const where: SQL[] = [eq(emails.teamId, teamId)];
  if (q.status) where.push(eq(emails.status, q.status));
  if (q.domainId) where.push(eq(emails.domainId, q.domainId));
  if (q.to) where.push(sql`${emails.to} ? ${q.to.trim().toLowerCase()}`);
  if (q.tag) {
    const i = q.tag.indexOf(":");
    const k = i < 0 ? q.tag : q.tag.slice(0, i);
    const v = i < 0 ? "" : q.tag.slice(i + 1);
    where.push(sql`${emails.tags} ->> ${k} = ${v}`);
  }
  if (cur)
    where.push(
      sql`(${emails.createdAt}, ${emails.id}) < (${cur.createdAt.toISOString()}::timestamptz, ${cur.id})`,
    );
  const rows = await db()
    .select()
    .from(emails)
    .where(and(...where))
    .orderBy(desc(emails.createdAt), desc(emails.id))
    .limit(q.limit + 1);
  const data = rows.slice(0, q.limit);
  const last = data[data.length - 1];
  return {
    ok: true,
    data: {
      data,
      nextCursor: rows.length > q.limit && last ? encodeCursor(last) : null,
    },
  };
}

/**
 * Only `queued`/`scheduled` can be cancelled; the status flip is a single
 * conditional update so a concurrently starting send cannot be undone. The
 * pg-boss job is left in place: the `email.send` handler re-reads the row
 * and skips anything not queued/scheduled.
 */
export async function cancelEmail(
  teamId: string,
  id: string,
  actorUserId: string | null,
): Promise<SendResult> {
  const current = await getEmail(teamId, id);
  if (!current) return fail("not_found", "Email not found.");
  const [row] = await db()
    .update(emails)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(emails.id, id),
        eq(emails.teamId, teamId),
        inArray(emails.status, [...CANCELLABLE]),
      ),
    )
    .returning();
  if (!row)
    return fail(
      "conflict",
      `Only queued or scheduled emails can be cancelled (status: ${current.status}).`,
    );
  await recordEvent({
    emailId: id,
    teamId,
    type: "cancelled",
    dedupeKey: `local:${id}:cancelled`,
    payload: actorUserId ? { actorUserId } : {},
  });
  return { ok: true, data: row };
}

const futureIso = z.iso.datetime({ offset: true });

/**
 * Moves a `scheduled` email, records a `queued` event carrying the new time
 * so the timeline shows the move, notifies the team and sends a fresh
 * delayed job. The earlier job
 * still fires at the old time; the `email.send` handler sees `scheduledAt`
 * still in the future and skips it, so the stale job is harmless.
 */
export async function rescheduleEmail(
  teamId: string,
  id: string,
  scheduledAt: string,
  deps: { enqueue: Enqueue; now?: Date; actorUserId?: string | null },
): Promise<SendResult> {
  const now = deps.now ?? new Date();
  const p = futureIso.safeParse(scheduledAt);
  const at = p.success ? new Date(p.data) : null;
  if (!at || at.getTime() <= now.getTime())
    return fail(
      "validation_error",
      "scheduledAt must be an ISO 8601 date-time in the future.",
    );
  const current = await getEmail(teamId, id);
  if (!current) return fail("not_found", "Email not found.");
  const [row] = await db()
    .update(emails)
    .set({ scheduledAt: at })
    .where(
      and(
        eq(emails.id, id),
        eq(emails.teamId, teamId),
        eq(emails.status, "scheduled"),
      ),
    )
    .returning();
  if (!row)
    return fail(
      "conflict",
      `Only scheduled emails can be rescheduled (status: ${current.status}).`,
    );
  await recordEvent({
    emailId: id,
    teamId,
    type: "queued",
    dedupeKey: `local:${id}:reschedule:${at.toISOString()}`,
    payload: {
      rescheduledTo: at.toISOString(),
      ...(deps.actorUserId && { actorUserId: deps.actorUserId }),
    },
  });
  await deps.enqueue(Q.emailSend, { emailId: id }, delayOpts(at, now));
  return { ok: true, data: row };
}

/**
 * Dashboard "Resend": a fresh email from the stored content. Tracking
 * rewrites are undone first (`createEmail` re-applies them under the new
 * id); attachment bytes are re-read while retention still holds them.
 */
export async function resendEmail(
  ctx: SendContext,
  id: string,
  deps: { enqueue: Enqueue; now?: Date },
): Promise<CreateResult> {
  const e = await getEmail(ctx.teamId, id);
  if (!e) return fail("not_found", "Email not found.");
  if (e.bodyPurgedAt)
    return fail(
      "conflict",
      "The body was purged by retention; nothing to resend.",
    );
  if (["queued", "scheduled", "sending"].includes(e.status))
    return fail(
      "conflict",
      `This email is still ${e.status}; wait for it to finish before resending.`,
    );
  // Peak memory is roughly 3x the attachment total: the raw bytes, their
  // base64 string, and the copy `createEmail` decodes again (bounded by the
  // per-attachment size limit in the shared schema).
  const atts = await db()
    .select({
      filename: emailAttachments.filename,
      contentType: emailAttachments.contentType,
      bytes: emailAttachments.bytes,
    })
    .from(emailAttachments)
    .where(eq(emailAttachments.emailId, id));
  const base = loadEnv().APP_URL;
  return createEmail(
    ctx,
    {
      from: e.from,
      to: e.to,
      cc: e.cc,
      bcc: e.bcc,
      replyTo: e.replyTo,
      subject: e.subject,
      html: e.html ? unwrapTracking(e.html, base) : undefined,
      text: e.text ?? undefined,
      headers: e.headers,
      tags: e.tags,
      trackOpens: e.trackOpens,
      trackClicks: e.trackClicks,
      attachments: atts.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: Buffer.from(a.bytes).toString("base64"),
      })),
    },
    // Provenance travels; the render does not. A resend is of *that message*,
    // so re-rendering could change the bytes under a customer who asked for
    // the same mail again — but the copy is still template-derived, and a row
    // with `template_id: null` beside a body full of substituted values is the
    // mail log lying about where the message came from. Retention cannot leak
    // through this: a purged row is refused above, and a purged row's
    // `variables` are `null` anyway, so the copy could only inherit the null.
    {
      ...deps,
      provenance: { templateId: e.templateId, variables: e.variables },
    },
  );
}
