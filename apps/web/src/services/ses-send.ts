import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { emailAttachments, emails } from "@/db/schema";
import { makeSes } from "@/lib/aws/clients";
import { resolveAwsContext } from "@/lib/aws/credentials";
import { formatAddress, parseAddress } from "@/lib/email-address";
import { Q } from "@/jobs/queues";
import { getInstanceSettings } from "./instance-settings";
import { takeSesToken } from "./send-limits";
import { recordEvent } from "./email-events";
import type { Enqueue } from "./domains";

export type SendOutcome =
  | { outcome: "sent" }
  | { outcome: "throttled"; retryInMs: number }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string };

/** SES errors a retry cannot fix: the message is marked `failed` at once. */
const NO_RETRY = new Set([
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

/** A job may fire this much before `scheduledAt` (pg-boss polling jitter). */
const DUE_SLACK_MS = 1000;
const SENDABLE = ["queued", "scheduled"] as const;

/**
 * One `email.send` attempt. Order matters:
 *  1. cheap skip for rows that are gone, cancelled, or not due (a stale job
 *     after a reschedule) — no SES token is spent on them;
 *  2. take an instance-wide SES token; when empty, re-enqueue with a delay
 *     and leave the row untouched (`throttled` is not a failure);
 *  3. claim the row atomically (`queued|scheduled` → `sending`), so two
 *     workers or a cancel racing the send cannot both win. The token comes
 *     before the claim on purpose: claiming first would park rows in
 *     `sending` while they wait for a token (and a crash there strands them,
 *     see `reconcileStuckSending`), whereas this order only wastes a token
 *     in the rare case the claim loses a race;
 *  4. SES SendEmail. Success writes `ses_message_id` before the `sent` event
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
  if (pre.scheduledAt && pre.scheduledAt > dueBy)
    return { outcome: "skipped", reason: "not_due" };

  const token = await takeSesToken(now);
  if (!token.ok) {
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

  try {
    const ctx = await resolveAwsContext();
    const settings = await getInstanceSettings();
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
        ConfigurationSetName: settings.sesConfigSet ?? undefined,
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
    if (NO_RETRY.has(name) || finalAttempt) {
      await markSendFailed(e, lastError, {
        name,
        message,
        ...(sandbox && { code: "sandbox_restricted" }),
      });
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

async function markSendFailed(
  e: { id: string; teamId: string; attempts: number },
  lastError: string,
  payload: Record<string, unknown>,
) {
  await db()
    .update(emails)
    .set({ status: "failed", lastError })
    .where(eq(emails.id, e.id));
  await recordEvent({
    emailId: e.id,
    teamId: e.teamId,
    type: "failed",
    dedupeKey: `local:${e.id}:failed:${e.attempts}`,
    payload,
    occurredAt: new Date(),
  });
}

/**
 * Cron fallback for rows a crashed worker left in `sending` (the normal
 * path never does: every exit of `sendQueuedEmail` moves the row on). A
 * row whose `updated_at` is older than 10 minutes is settled from what we
 * know: with a `ses_message_id` the send completed and only the bookkeeping
 * was lost → `sent`; without one we cannot tell whether SES accepted the
 * message, and a retry could double-send → `failed`, no retry. Returns the
 * ids settled each way.
 */
export async function reconcileStuckSending(
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
        "Send did not complete (worker interrupted); not retried because SES may have accepted it.",
        { name: "WorkerInterrupted", reconciled: true },
      );
      out.failed.push(e.id);
    }
  }
  return out;
}
