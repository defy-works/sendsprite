import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  SUPPRESSION_REASONS,
  type SuppressionReason,
} from "@sendsprite/shared";
import { db } from "@/db";
import { emailAttachments, emails } from "@/db/schema";
import { makeSes } from "@/lib/aws/clients";
import { resolveAwsContext } from "@/lib/aws/credentials";
import { formatAddress, parseAddress } from "@/lib/email-address";
import { Q } from "@/jobs/queues";
import { getTeamAws, isCredentialFailure, noteAwsFailure } from "./team-aws";
import { takeSesToken } from "./send-limits";
import { RECONCILED_FAILED_PREFIX, recordEvent } from "./email-events";
import { publicEmail } from "./ingest";
import { isSuppressed } from "./suppressions";
import { fanOutEvent } from "./webhooks";
import type { Enqueue } from "./domains";

type EmailRow = typeof emails.$inferSelect;
export type SendOutcome =
  | { outcome: "sent" }
  | { outcome: "throttled"; retryInMs: number }
  | { outcome: "deferred"; retryInMs: number }
  | { outcome: "skipped"; reason: string }
  | { outcome: "suppressed"; reason: SuppressionReason }
  | { outcome: "failed"; error: string };

/**
 * Suppression reasons that block a send **at send time**, as opposed to at
 * create time — every reason except `manual`, derived rather than listed so a
 * reason added later blocks by default instead of silently slipping through.
 *
 * ## Why `manual` is the one exclusion, and how that honours `overrideSuppression`
 *
 * `createEmail` lets a caller set `overrideSuppression`, which bypasses
 * `manual` entries and nothing else (a `sending_only` key cannot even do
 * that). The flag is not persisted on the `emails` row, so this function
 * cannot tell an email created *with* it from any other — and re-applying the
 * full create-time check here would cancel exactly the emails the flag exists
 * to let through, silently, hours later, with no way for the caller to know.
 *
 * Excluding `manual` makes the question moot: the only reason the flag can
 * bypass is the only reason this does not check, so an override-created email
 * still sends, and no email is refused here on a ground a caller was
 * permitted to waive. The cost is that a `manual` entry added *after* an email
 * was created does not stop it — the operator's own list, added by hand, is
 * not the reputation or compliance emergency this check exists for. Bounces
 * and complaints are, and they are also precisely the two reasons the flag has
 * never been able to waive. (Persisting the flag on `emails` would let this
 * check `manual` too; that is a migration, and it buys very little.)
 */
const BLOCKS_AT_SEND: ReadonlySet<SuppressionReason> = new Set(
  SUPPRESSION_REASONS.filter((r) => r !== "manual"),
);

/** SES errors a retry cannot fix: the message is marked `failed` at once. */
const NO_RETRY = new Set([
  // An IAM policy gap, not a blip: the same key will be refused on every
  // attempt, so the five backoff retries only delay the verdict by ~15 minutes
  // and bury the one message an operator needs to read. Key propagation right
  // after a connect fails as `InvalidClientTokenId`, not this, and
  // `verifyIdentity` already waits that out (services/aws-connect.ts).
  "AccessDeniedException",
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "SendingPausedException",
  "BadRequestException",
  "NotFoundException",
  "ValidationException",
]);

/**
 * SES sandbox refusal, verbatim: "Email address is not verified. The
 * following identities failed the check in region EU-WEST-1: r@x.io".
 * "failed the check" is specific to that identity check; a bare "not
 * verified" would also match unrelated MessageRejected texts.
 */
const isSandboxRejection = (name: string, message: string) =>
  name === "MessageRejected" && /failed the check/i.test(message);

/** A `sending` row older than this has lost its worker (crash, SIGKILL). */
const STUCK_SENDING_MS = 10 * 60 * 1000;
/** A due `queued`/`scheduled` row untouched this long has lost its job. */
const STALE_QUEUED_MS = 5 * 60 * 1000;
/** Rows one queued sweep re-enqueues at most; the next tick takes the rest. */
const SWEEP_BATCH = 5000;

/**
 * Bumps `updated_at` so `sweepQueuedEmails` (5-minute staleness) does not
 * treat a row a worker is actively throttling/deferring as orphaned.
 */
const touch = (emailId: string) =>
  db()
    .update(emails)
    .set({ updatedAt: new Date() })
    .where(eq(emails.id, emailId));

/** A job may fire this much before `scheduledAt` (pg-boss polling jitter). */
const DUE_SLACK_MS = 1000;
const SENDABLE = ["queued", "scheduled"] as const;

/**
 * One `email.send` attempt. Order matters:
 *  1. cheap skip for rows that are gone or cancelled — no SES token is spent
 *     on them. A row not yet due (a stale job after a reschedule, or a
 *     delayed job that fired early) is `deferred`: a fresh delayed job is
 *     sent for its `scheduledAt`, so the row never depends on another job
 *     still existing;
 *  2. take an instance-wide SES token; when empty, re-enqueue with a delay
 *     and leave the row untouched (`throttled` is not a failure);
 *  3. claim the row atomically (`queued|scheduled` → `sending`), so two
 *     workers or a cancel racing the send cannot both win. The token comes
 *     before the claim on purpose: claiming first would park rows in
 *     `sending` while they wait for a token (and a crash there strands them,
 *     see `reconcileStuckSending`), whereas this order only wastes a token
 *     in the rare case the claim loses a race;
 *  4. re-check the suppression list (see {@link blockingSuppression}). It is
 *     after the claim rather than before it because the row must be *ours*
 *     before we may move it: a check on the pre-read would have to cancel a
 *     row another worker could already be handing to SES;
 *  5. SES SendEmail. Success writes `ses_message_id` before the `sent` event
 *     so an early SNS `Delivery` can already match by message id.
 * A row never stays `sending`: a non-retryable SES error marks it `failed`;
 * a retryable one reverts it to `queued` and rethrows for pg-boss — except
 * on the handler's `finalAttempt`, where it is `failed` too.
 */
export async function sendQueuedEmail(
  emailId: string,
  deps: { enqueue: Enqueue; now?: Date },
  { finalAttempt = false }: { finalAttempt?: boolean } = {},
): Promise<SendOutcome> {
  const now = deps.now ?? new Date();
  const [pre] = await db().select().from(emails).where(eq(emails.id, emailId));
  if (!pre) return { outcome: "skipped", reason: "missing" };
  if (!(SENDABLE as readonly string[]).includes(pre.status))
    return { outcome: "skipped", reason: pre.status };
  const dueBy = new Date(now.getTime() + DUE_SLACK_MS);
  if (pre.scheduledAt && pre.scheduledAt > dueBy) {
    const retryInMs = pre.scheduledAt.getTime() - now.getTime();
    await touch(emailId);
    await deps.enqueue(
      Q.emailSend,
      { emailId },
      { startAfter: Math.max(1, Math.ceil(retryInMs / 1000)) },
    );
    return { outcome: "deferred", retryInMs };
  }

  const token = await takeSesToken(pre.teamId, now);
  if (!token.ok) {
    await touch(emailId);
    await deps.enqueue(
      Q.emailSend,
      { emailId },
      { startAfter: Math.max(1, Math.ceil(token.retryInMs / 1000)) },
    );
    return { outcome: "throttled", retryInMs: token.retryInMs };
  }

  const [e] = await db()
    .update(emails)
    .set({ status: "sending", attempts: sql`${emails.attempts} + 1` })
    .where(
      and(
        eq(emails.id, emailId),
        inArray(emails.status, [...SENDABLE]),
        or(isNull(emails.scheduledAt), lte(emails.scheduledAt, dueBy)),
      ),
    )
    .returning();
  // Cancelled, rescheduled or claimed by another worker since the pre-read.
  if (!e) return { outcome: "skipped", reason: "not_claimed" };

  const hit = await blockingSuppression(e);
  if (hit) {
    await markSuppressed(e, hit);
    return { outcome: "suppressed", reason: hit.reason };
  }

  try {
    const ctx = await resolveAwsContext(e.teamId);
    const aws = await getTeamAws(e.teamId);
    const atts = e.attachmentsMeta.length
      ? await db()
          .select()
          .from(emailAttachments)
          .where(eq(emailAttachments.emailId, emailId))
      : [];
    const from = parseAddress(e.from);
    if (!from)
      throw Object.assign(new Error("Invalid from address"), {
        name: "BadRequestException",
      });
    const headers = Object.entries(e.headers);
    const res = await makeSes(ctx).send(
      new SendEmailCommand({
        FromEmailAddress: formatAddress(from),
        Destination: {
          ToAddresses: e.to,
          ...(e.cc.length > 0 && { CcAddresses: e.cc }),
          ...(e.bcc.length > 0 && { BccAddresses: e.bcc }),
        },
        ...(e.replyTo.length > 0 && { ReplyToAddresses: e.replyTo }),
        ConfigurationSetName: aws?.configSet ?? undefined,
        // Opens/clicks are tracked by our own endpoints; SES's would double count.
        ConfigurationOverrides: {
          Tracking: {
            OpenTrackingEnabled: "DISABLED",
            ClickTrackingEnabled: "DISABLED",
          },
        },
        EmailTags: [
          { Name: "ss_email", Value: e.id },
          { Name: "ss_team", Value: e.teamId },
        ],
        Content: {
          Simple: {
            Subject: { Data: e.subject, Charset: "UTF-8" },
            Body: {
              ...(e.html && { Html: { Data: e.html, Charset: "UTF-8" } }),
              ...(e.text && { Text: { Data: e.text, Charset: "UTF-8" } }),
            },
            ...(headers.length > 0 && {
              Headers: headers.map(([Name, Value]) => ({ Name, Value })),
            }),
            ...(atts.length > 0 && {
              Attachments: atts.map((a) => ({
                FileName: a.filename,
                ContentType: a.contentType,
                RawContent: a.bytes,
                ContentDisposition: "ATTACHMENT" as const,
              })),
            }),
          },
        },
      }),
    );
    // SES accepted the message at response time, not when the job started.
    const acceptedAt = new Date();
    await db()
      .update(emails)
      .set({ sesMessageId: res.MessageId ?? null, lastError: null })
      .where(eq(emails.id, emailId));
    await recordEvent({
      emailId,
      teamId: e.teamId,
      type: "sent",
      dedupeKey: `local:${emailId}:sent`,
      payload: { sesMessageId: res.MessageId },
      occurredAt: acceptedAt,
    });
    return { outcome: "sent" };
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "Error";
    const message = (err as Error)?.message ?? String(err);
    const sandbox = isSandboxRejection(name, message);
    const lastError = sandbox
      ? `sandbox_restricted: ${message}`
      : `${name}: ${message}`;
    // A refused key is a fact about the connection, not this one email; the
    // row is what the dashboard reads. Best effort — the email's own outcome
    // must not depend on this write.
    if (isCredentialFailure(name))
      await noteAwsFailure(e.teamId, name, message).catch((err: unknown) =>
        console.warn("ses-send: could not note credential failure:", err),
      );
    if (NO_RETRY.has(name) || finalAttempt) {
      await markSendFailed(
        e,
        lastError,
        { name, message, ...(sandbox && { code: "sandbox_restricted" }) },
        deps,
      );
      if (NO_RETRY.has(name)) return { outcome: "failed", error: message };
      throw err;
    }
    await db()
      .update(emails)
      .set({ status: "queued", lastError })
      .where(and(eq(emails.id, emailId), eq(emails.status, "sending")));
    throw err; // pg-boss retries with backoff
  }
}

/**
 * The suppression entry that must stop this send, or null.
 *
 * ## Why the check is here and not only in `createEmail`
 *
 * Create and send are the same second for an ordinary API call, and were the
 * only two moments the product had — so one check at create time looked like
 * enough. Two later features opened a gap between them that is measured in
 * hours: `scheduledAt` on `POST /emails`, and campaigns, whose fan-out
 * materialises `emails` rows in chunks and can hand the last recipient to SES
 * long after `selectEligible` filtered the suppressed contacts out of the
 * first. A hard bounce or a complaint landing in that window was ignored
 * entirely: the fan-out does not call `createEmail`, and nothing downstream
 * looked again. Mailing an address SES already bounced is how a sending
 * reputation is destroyed, and mailing one that already complained is a
 * compliance failure rather than merely a deliverability one — so the list is
 * read once more with the row already claimed.
 *
 * ## Cost
 *
 * One indexed lookup per send: `suppressions_team_email_uidx` is exactly
 * `(team_id, email)` and `isSuppressed` takes the whole recipient set as one
 * `in (...)`, so a send costs one index probe however many recipients it has.
 * That sits behind `takeSesToken` — a transaction that takes a row lock
 * `for update` on the team's bucket row and therefore serialises every worker
 * sending for that team — and beside `resolveAwsContext`, `getTeamAws` and
 * the claim, all of which are already per-send round trips. It is noise on
 * this path. If it ever stops being noise, the alternative is not to drop it
 * but to fold it into the claim (a `not exists` sub-select on the conditional
 * UPDATE), which costs nothing extra at all; that was not done here because
 * the claim would then have no way to report *which* address was suppressed,
 * and the timeline event is half the point.
 *
 * Addresses are compared as `isSuppressed` normalises them, so `cc` and `bcc`
 * are checked exactly as `createEmail` checks them.
 */
async function blockingSuppression(
  e: EmailRow,
): Promise<{ email: string; reason: SuppressionReason } | null> {
  const hits = await isSuppressed(e.teamId, [...e.to, ...e.cc, ...e.bcc]);
  return hits.find((h) => BLOCKS_AT_SEND.has(h.reason)) ?? null;
}

/**
 * `sending` → `cancelled`, with a `cancelled` event naming the address and
 * the reason.
 *
 * ## Why `cancelled` and not `failed`
 *
 * `failed` means the transport refused the message, and it is the status a
 * `MessageRejected` or an exhausted retry produces; it carries an
 * `email.failed` webhook and it is what a customer reads as "SES had a
 * problem with this". Nothing failed here — we declined to send, on purpose,
 * for a reason that is ours and not SES's. Filing it under `failed` would
 * inflate exactly the failure rate an operator watches to judge their
 * reputation, using messages that never touched SES: the metric would move in
 * response to the guard protecting it.
 *
 * `cancelled` already means "queued, then deliberately not sent" — it is what
 * `cancelEmail` writes, `emailEvents` ranks it with the pre-send states, and
 * neither it nor `failed` is in `SEND_CONSUMING_STATUS`, so the customer is
 * not billed for it either way. In a mail log "cancelled — suppressed
 * recipient (bounce)" reads as the truth; "failed" would not.
 *
 * (`rejected` exists as an *event* type, not a status: `email_events.rejected`
 * is SES's own rejection, mapped to the `failed` status by `STATUS_FOR`. It is
 * SES's verdict and is not available to mean ours.)
 *
 * ## What the customer sees
 *
 * The timeline event, so the email is explained rather than merely absent:
 * an email that stopped at `queued` with nothing after it is the outcome this
 * function exists to avoid. `lastError` carries the same sentence for the list
 * view. No webhook: there is no `email.cancelled` event type, and a
 * suppression is not a delivery outcome — the same choice `cancelEmail`
 * already makes.
 *
 * Guarded on `status = 'sending'`, like `markSendFailed`: if anything else
 * moved the row since the claim, it is left alone and gets no event.
 */
async function markSuppressed(
  e: EmailRow,
  hit: { email: string; reason: SuppressionReason },
): Promise<void> {
  const [row] = await db()
    .update(emails)
    .set({
      status: "cancelled",
      lastError: `suppressed_recipient: ${hit.email} (${hit.reason})`,
    })
    .where(and(eq(emails.id, e.id), eq(emails.status, "sending")))
    .returning({ id: emails.id });
  if (!row) return;
  await recordEvent({
    emailId: e.id,
    teamId: e.teamId,
    type: "cancelled",
    // Distinct from `cancelEmail`'s `local:<id>:cancelled`: a customer cancel
    // and a suppression stop are different facts and both belong on the
    // timeline if both happen.
    dedupeKey: `local:${e.id}:suppressed`,
    payload: {
      reason: "suppressed_recipient",
      email: hit.email,
      suppressionReason: hit.reason,
    },
  });
}

/**
 * `sending` → `failed` with a `failed` timeline event and an `email.failed`
 * webhook fan-out. Guarded on `status = 'sending'`: a row that something
 * else already moved (an SNS event, a concurrent reconcile) is left alone
 * and gets no event.
 */
async function markSendFailed(
  e: EmailRow,
  lastError: string,
  payload: Record<string, unknown>,
  deps: { enqueue: Enqueue },
) {
  const [row] = await db()
    .update(emails)
    .set({ status: "failed", lastError })
    .where(and(eq(emails.id, e.id), eq(emails.status, "sending")))
    .returning();
  if (!row) return;
  const occurredAt = new Date();
  const ev = await recordEvent({
    emailId: e.id,
    teamId: e.teamId,
    type: "failed",
    dedupeKey: `local:${e.id}:failed:${e.attempts}`,
    payload,
    occurredAt,
  });
  if (!ev) return;
  await fanOutEvent(
    e.teamId,
    "email.failed",
    ev.id,
    {
      email: publicEmail(row),
      event: {
        type: "failed",
        occurredAt: occurredAt.toISOString(),
        ...payload,
      },
    },
    { enqueue: deps.enqueue, createdAt: occurredAt },
  );
}

/**
 * Cron fallback for due `queued`/`scheduled` rows whose `email.send` job
 * was lost (the enqueue at create time failed, pg-boss dropped or expired
 * it, a deferred re-send never landed). A row untouched for 5 minutes past
 * its due time gets a fresh job; the atomic claim in `sendQueuedEmail`
 * makes a duplicate job harmless. Throttled/deferred rows are touched by
 * the worker so they are not swept. At most SWEEP_BATCH rows per tick (a
 * backlog after a long outage is drained over a few ticks rather than
 * flooding the queue in one). Returns the ids enqueued.
 */
export async function sweepQueuedEmails(
  deps: { enqueue: Enqueue },
  now = new Date(),
): Promise<string[]> {
  const rows = await db()
    .select({ id: emails.id })
    .from(emails)
    .where(
      and(
        inArray(emails.status, [...SENDABLE]),
        or(isNull(emails.scheduledAt), lte(emails.scheduledAt, now)),
        lt(emails.updatedAt, new Date(now.getTime() - STALE_QUEUED_MS)),
      ),
    )
    .orderBy(emails.createdAt)
    .limit(SWEEP_BATCH);
  for (const r of rows) await deps.enqueue(Q.emailSend, { emailId: r.id });
  return rows.map((r) => r.id);
}

/**
 * Cron fallback for rows a crashed worker left in `sending` (the normal
 * path never does: every exit of `sendQueuedEmail` moves the row on). A
 * row whose `updated_at` is older than 10 minutes is settled from what we
 * know: with a `ses_message_id` the send completed and only the bookkeeping
 * was lost → `sent`; without one we cannot tell whether SES accepted the
 * message, and a retry could double-send → `failed`, no retry. Both writes
 * are guarded on the row still being `sending`, and a `failed` set here is
 * recognisable by its `lastError` prefix (`RECONCILED_FAILED_PREFIX`) so a
 * late SNS `delivered`/`bounced` can still overtake it (see `recordEvent`).
 * Returns the ids settled each way.
 */
export async function reconcileStuckSending(
  deps: { enqueue: Enqueue },
  now = new Date(),
): Promise<{ sent: string[]; failed: string[] }> {
  const cutoff = new Date(now.getTime() - STUCK_SENDING_MS);
  const rows = await db()
    .select()
    .from(emails)
    .where(and(eq(emails.status, "sending"), lt(emails.updatedAt, cutoff)));
  const out = { sent: [] as string[], failed: [] as string[] };
  for (const e of rows) {
    if (e.sesMessageId) {
      await recordEvent({
        emailId: e.id,
        teamId: e.teamId,
        type: "sent",
        dedupeKey: `local:${e.id}:reconciled`,
        payload: { sesMessageId: e.sesMessageId, reconciled: true },
        // Sweep time, not the stale `updatedAt`: the timeline must not put
        // `sent` before `queued`, and the true accept time is unknown.
        occurredAt: now,
      });
      out.sent.push(e.id);
    } else {
      await markSendFailed(
        e,
        `${RECONCILED_FAILED_PREFIX} (worker interrupted); not retried because SES may have accepted it.`,
        { name: "WorkerInterrupted", reconciled: true },
        deps,
      );
      out.failed.push(e.id);
    }
  }
  return out;
}
