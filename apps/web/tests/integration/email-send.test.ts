import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";
import { connectTeamAws } from "./helpers";

const ses = mockClient(SESv2Client);
/**
 * The concurrency test parks both callers after their pre-read so they race
 * the atomic claim rather than the pre-read (a serialised pool would let the
 * second pre-read see the first send already done).
 */
const gate = vi.hoisted(() => ({ delayMs: 0 }));
vi.mock("@/services/send-limits", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/services/send-limits")>();
  return {
    ...mod,
    takeSesToken: async (teamId: string, now?: Date) => {
      if (gate.delayMs) await new Promise((r) => setTimeout(r, gate.delayMs));
      return mod.takeSesToken(teamId, now);
    },
  };
});
let pg: Awaited<ReturnType<typeof startPg>>;

beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  process.env.APP_URL = "http://localhost:3000";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
  const { domains } = await import("@/db/schema");
  await pg.db.insert(domains).values({
    id: "dom_1",
    teamId: "org_1",
    name: "mail.acme.com",
    region: "eu-west-1",
    dnsMode: "manual",
    mailFromDomain: "bounce.mail.acme.com",
    status: "verified",
  });
  await connectTeamAws("org_1", {
    region: "eu-west-1",
    configSet: "sendsprite",
    sesMaxSendRate: 1,
  });
});
afterAll(async () => {
  await pg.stop();
});
/** Each test starts with a full bucket (rate 1, last refill well in the past). */
beforeEach(async () => {
  ses.reset();
  const { resetRateForTests } = await import("@/services/send-limits");
  await resetRateForTests("org_1", new Date(Date.now() - 10_000));
});
afterEach(() => {
  ses.reset();
});

const ctx = {
  teamId: "org_1",
  source: "api" as const,
  apiKeyId: "key_1",
  actorUserId: null,
};
const base = {
  from: "a@mail.acme.com",
  to: ["r@x.io"],
  subject: "s",
  text: "t",
};
const awsErr = (name: string, message: string) =>
  Object.assign(new Error(message), { name });

async function create(input: Record<string, unknown> = {}) {
  const { createEmail } = await import("@/services/emails");
  const r = await createEmail(
    ctx,
    { ...base, ...input },
    { enqueue: async () => "" },
  );
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
async function load(id: string) {
  const { getEmail } = await import("@/services/emails");
  const e = await getEmail("org_1", id);
  if (!e) throw new Error("missing");
  return e;
}
async function events(id: string) {
  const { listEvents } = await import("@/services/email-events");
  return (await listEvents(id)).map((e) => e.type);
}

describe("sendQueuedEmail", () => {
  it("sends via SESv2 Simple content with attachments, tags and headers; records ses_message_id and sent event", async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: "ses-1" });
    const created = await create({
      from: "Acme <hello@mail.acme.com>",
      cc: ["c@x.io"],
      replyTo: ["re@mail.acme.com"],
      subject: "Hi",
      html: "<p>h</p>",
      headers: { "X-Ref": "1" },
      attachments: [
        {
          filename: "a.txt",
          content: Buffer.from("hi").toString("base64"),
          contentType: "text/plain",
        },
      ],
    });
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, {
      enqueue: vi.fn(async () => ""),
    });
    expect(out).toEqual({ outcome: "sent" });
    const input = ses.commandCalls(SendEmailCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      FromEmailAddress: '"Acme" <hello@mail.acme.com>',
      Destination: { ToAddresses: ["r@x.io"], CcAddresses: ["c@x.io"] },
      ReplyToAddresses: ["re@mail.acme.com"],
      ConfigurationSetName: "sendsprite",
      EmailTags: expect.arrayContaining([
        { Name: "ss_email", Value: created.id },
        { Name: "ss_team", Value: "org_1" },
      ]),
      ConfigurationOverrides: {
        Tracking: {
          OpenTrackingEnabled: "DISABLED",
          ClickTrackingEnabled: "DISABLED",
        },
      },
    });
    expect(input.Destination?.BccAddresses).toBeUndefined();
    expect(input.Content?.Simple?.Subject).toEqual({
      Data: "Hi",
      Charset: "UTF-8",
    });
    expect(input.Content?.Simple?.Body?.Text?.Data).toBe("t");
    expect(input.Content?.Simple?.Body?.Html?.Data).toContain("<p>h</p>");
    expect(input.Content?.Simple?.Headers).toEqual([
      { Name: "X-Ref", Value: "1" },
    ]);
    const att = input.Content?.Simple?.Attachments?.[0];
    expect(att).toMatchObject({
      FileName: "a.txt",
      ContentType: "text/plain",
      ContentDisposition: "ATTACHMENT",
    });
    expect(Buffer.from(att!.RawContent!).toString()).toBe("hi");
    const e = await load(created.id);
    expect(e).toMatchObject({
      status: "sent",
      sesMessageId: "ses-1",
      attempts: 1,
      lastError: null,
    });
    expect(e.sentAt).toBeInstanceOf(Date);
    expect(await events(created.id)).toEqual(["queued", "sent"]);
  });

  it("waits for a rate token: re-enqueues with startAfter and does not call SES", async () => {
    const now = new Date();
    const { resetRateForTests } = await import("@/services/send-limits");
    await resetRateForTests("org_1", now);
    const created = await create();
    const enqueue = vi.fn(async () => "");
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, { enqueue, now });
    expect(out).toMatchObject({ outcome: "throttled" });
    if (out.outcome !== "throttled") return;
    expect(out.retryInMs).toBeGreaterThan(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [queue, data, opts] = enqueue.mock.calls[0] as unknown as [
      string,
      object,
      { startAfter?: number },
    ];
    expect(queue).toBe("email.send");
    expect(data).toEqual({ emailId: created.id });
    expect(opts.startAfter).toBeGreaterThanOrEqual(1);
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(await load(created.id)).toMatchObject({
      status: "queued",
      attempts: 0,
    });
  });

  it("MessageRejected → failed with a failed event and an email.failed webhook delivery; no rethrow", async () => {
    ses
      .on(SendEmailCommand)
      .rejects(awsErr("MessageRejected", "Email address is blacklisted."));
    const { createWebhook } = await import("@/services/webhooks");
    const hook = await createWebhook(
      { userId: "u1", teamId: "org_1", teamName: "Acme", role: "owner" },
      { url: "https://hooks.acme.com/failed", events: ["email.failed"] },
    );
    if (!hook.ok) throw new Error(hook.error);
    const created = await create();
    const enqueue = vi.fn(async () => "");
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, { enqueue });
    expect(out).toEqual({
      outcome: "failed",
      error: "Email address is blacklisted.",
    });
    expect(await load(created.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "MessageRejected: Email address is blacklisted.",
      sesMessageId: null,
    });
    expect(await events(created.id)).toEqual(["queued", "failed"]);
    const { webhookDeliveries, webhooks } = await import("@/db/schema");
    const rows = await pg.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, hook.data.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({
      type: "email.failed",
      data: {
        email: { id: created.id, status: "failed" },
        event: { type: "failed", name: "MessageRejected" },
      },
    });
    expect(enqueue).toHaveBeenCalledWith(
      "webhook.deliver",
      { deliveryId: rows[0]!.id },
      { singletonKey: rows[0]!.id },
    );
    await pg.db.delete(webhooks).where(eq(webhooks.id, hook.data.id));
  });

  /**
   * The IAM policy the connect stack creates was missing
   * `ses:ApplyTrackingConfigurationOverrides`, which every send needs because
   * every send disables SES's own open/click tracking. Retrying that five
   * times only postponed the same refusal by ~15 minutes, during which the
   * message sat in `queued` looking like a slow send rather than a broken
   * connection. See infra/aws/sendsprite-connect.yaml.
   */
  it("AccessDeniedException → failed at once, not five retries later", async () => {
    const msg =
      "User 'arn:aws:iam::1:user/sendsprite-x' is not authorized to perform 'ses:ApplyTrackingConfigurationOverrides'";
    ses.on(SendEmailCommand).rejects(awsErr("AccessDeniedException", msg));
    // Past the propagation grace, so the refusal counts against the
    // connection and not just this email.
    const { teamAws } = await import("@/db/schema");
    await pg.db
      .update(teamAws)
      .set({ connectedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(teamAws.teamId, "org_1"));
    const created = await create();
    const enqueue = vi.fn(async () => "");
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, { enqueue });
    expect(out).toEqual({ outcome: "failed", error: msg });
    expect(await load(created.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: `AccessDeniedException: ${msg}`,
    });
    expect(await events(created.id)).toEqual(["queued", "failed"]);
    // No re-enqueue: nothing is waiting on a retry that cannot succeed.
    expect(enqueue).not.toHaveBeenCalledWith(
      "email.send",
      expect.anything(),
      expect.anything(),
    );
    // The connection now says so too; that is what the dashboard reads.
    const { getTeamAws } = await import("@/services/team-aws");
    expect((await getTeamAws("org_1"))?.lastError).toMatch(
      /^AccessDeniedException: /,
    );
  });

  it("TooManyRequestsException → throws for pg-boss retry; status back to queued with lastError", async () => {
    ses
      .on(SendEmailCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    const created = await create();
    const { sendQueuedEmail } = await import("@/services/ses-send");
    await expect(
      sendQueuedEmail(created.id, { enqueue: vi.fn(async () => "") }),
    ).rejects.toThrow("Rate exceeded");
    expect(await load(created.id)).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "TooManyRequestsException: Rate exceeded",
    });
    expect(await events(created.id)).toEqual(["queued"]);
  });

  it("retryable error on the final attempt → failed with a failed event, still throws", async () => {
    ses
      .on(SendEmailCommand)
      .rejects(awsErr("TooManyRequestsException", "Rate exceeded"));
    const created = await create();
    const { sendQueuedEmail } = await import("@/services/ses-send");
    await expect(
      sendQueuedEmail(
        created.id,
        { enqueue: vi.fn(async () => "") },
        { finalAttempt: true },
      ),
    ).rejects.toThrow("Rate exceeded");
    expect(await load(created.id)).toMatchObject({
      status: "failed",
      lastError: "TooManyRequestsException: Rate exceeded",
    });
    expect(await events(created.id)).toEqual(["queued", "failed"]);
  });

  it("skips cancelled emails without calling SES", async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: "never" });
    const created = await create();
    const { cancelEmail } = await import("@/services/emails");
    const c = await cancelEmail("org_1", created.id, null);
    expect(c.ok).toBe(true);
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, {
      enqueue: vi.fn(async () => ""),
    });
    expect(out).toEqual({ outcome: "skipped", reason: "cancelled" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(await load(created.id)).toMatchObject({
      status: "cancelled",
      attempts: 0,
    });
  });

  /*
   * The window between "this email was created" and "this email is handed to
   * SES" is seconds for an ordinary API send and hours for the two features
   * built on top of it: a `scheduledAt` days out, and a campaign whose fan-out
   * materialises `emails` rows in chunks. `createEmail` checked the
   * suppression list and nothing looked again, so a hard bounce or a complaint
   * arriving inside that window was ignored and the address was mailed anyway
   * — which is how a sending reputation is destroyed, and for a complaint is a
   * compliance failure rather than a deliverability one.
   *
   * This is the campaign case stated on a plain queued row, because that is
   * what a campaign recipient *is*: the fan-out writes ordinary `emails` rows
   * and the same `email.send` path delivers them.
   */
  it("does not hand a message to SES for an address suppressed after it was queued", async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: "never" });
    const created = await create({ to: ["late-bounce@x.io"] });
    const { suppressFromEvent } = await import("@/services/suppressions");
    await suppressFromEvent(
      "org_1",
      [{ email: "late-bounce@x.io", reason: "bounce" }],
      null,
    );

    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, {
      enqueue: vi.fn(async () => ""),
    });

    expect(out).toEqual({ outcome: "suppressed", reason: "bounce" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    // `cancelled`, not `failed`: nothing failed, we declined to send. Filing
    // it as `failed` would inflate the very failure rate an operator reads to
    // judge their reputation, with messages that never reached SES.
    const row = await load(created.id);
    expect(row.status).toBe("cancelled");
    expect(row.lastError).toBe(
      "suppressed_recipient: late-bounce@x.io (bounce)",
    );
    // And the customer can see *why*, rather than finding an email that
    // stopped at `queued` with nothing after it.
    expect(await events(created.id)).toEqual(["queued", "cancelled"]);
    const { listEvents } = await import("@/services/email-events");
    const last = (await listEvents(created.id)).at(-1)!;
    expect(last.payload).toMatchObject({
      reason: "suppressed_recipient",
      email: "late-bounce@x.io",
      suppressionReason: "bounce",
    });
  });

  it("re-checks cc and bcc at send time too, exactly as createEmail does", async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: "never" });
    const created = await create({
      to: ["fine@x.io"],
      bcc: ["late-complaint@x.io"],
    });
    const { suppressFromEvent } = await import("@/services/suppressions");
    await suppressFromEvent(
      "org_1",
      [{ email: "late-complaint@x.io", reason: "complaint" }],
      null,
    );

    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, {
      enqueue: vi.fn(async () => ""),
    });

    expect(out).toEqual({ outcome: "suppressed", reason: "complaint" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(await load(created.id)).toMatchObject({ status: "cancelled" });
  });

  /*
   * The counterpart, and the one that would break a paying feature if the
   * send-time check were simply the create-time check run twice:
   * `overrideSuppression` is not stored on the `emails` row, so the send path
   * cannot recognise an email that was created *with* it. Excluding `manual`
   * — the only reason the flag can waive — is what makes the flag survive the
   * journey through the queue.
   */
  it("still sends an email created with overrideSuppression over a manual entry", async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: "ses-override" });
    const { db } = await import("@/db");
    const { suppressions } = await import("@/db/schema");
    const { newId } = await import("@sendsprite/shared");
    await db()
      .insert(suppressions)
      .values({
        id: newId("sup"),
        teamId: "org_1",
        email: "manual-block@x.io",
        reason: "manual",
      })
      .onConflictDoNothing();
    const created = await create({
      to: ["manual-block@x.io"],
      overrideSuppression: true,
    });

    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, {
      enqueue: vi.fn(async () => ""),
    });

    expect(out).toEqual({ outcome: "sent" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(await load(created.id)).toMatchObject({ status: "sent" });
  });

  it("defers a scheduled email that is not yet due: re-enqueues for scheduledAt, no SES call", async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: "never" });
    const now = new Date();
    const at = new Date(now.getTime() + 3600_000);
    const created = await create({ scheduledAt: at.toISOString() });
    expect(created.status).toBe("scheduled");
    const enqueue = vi.fn(async () => "");
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, { enqueue, now });
    expect(out).toEqual({ outcome: "deferred", retryInMs: 3600_000 });
    expect(enqueue).toHaveBeenCalledWith(
      "email.send",
      { emailId: created.id },
      { startAfter: 3600 },
    );
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(await load(created.id)).toMatchObject({
      status: "scheduled",
      attempts: 0,
    });
  });

  it("sends a scheduled email once its time has come", async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: "ses-due" });
    const at = new Date(Date.now() + 3600_000);
    const created = await create({ scheduledAt: at.toISOString() });
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, {
      enqueue: vi.fn(async () => ""),
      now: at,
    });
    expect(out).toEqual({ outcome: "sent" });
    expect(await load(created.id)).toMatchObject({
      status: "sent",
      sesMessageId: "ses-due",
    });
  });

  it("missing email → skipped", async () => {
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail("em_nope", {
      enqueue: vi.fn(async () => ""),
    });
    expect(out).toEqual({ outcome: "skipped", reason: "missing" });
  });

  it("sandbox: SES MessageRejected 'Email address is not verified' maps to sandbox_restricted in lastError", async () => {
    const msg =
      "Email address is not verified. The following identities failed the check in region EU-WEST-1: r@x.io";
    ses.on(SendEmailCommand).rejects(awsErr("MessageRejected", msg));
    const created = await create();
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, {
      enqueue: vi.fn(async () => ""),
    });
    expect(out).toEqual({ outcome: "failed", error: msg });
    const e = await load(created.id);
    expect(e.status).toBe("failed");
    expect(e.lastError?.startsWith("sandbox_restricted")).toBe(true);
    const { listEvents } = await import("@/services/email-events");
    const failed = (await listEvents(created.id)).find(
      (ev) => ev.type === "failed",
    );
    expect(failed?.payload).toMatchObject({ code: "sandbox_restricted" });
  });

  it("two concurrent attempts: exactly one SES call, one sent event, the loser is skipped: not_claimed", async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: "ses-race" });
    await connectTeamAws("org_1", { sesMaxSendRate: 2 });
    const { resetRateForTests } = await import("@/services/send-limits");
    await resetRateForTests("org_1", new Date(Date.now() - 10_000));
    const created = await create();
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const deps = { enqueue: vi.fn(async () => "") };
    gate.delayMs = 100;
    let outs;
    try {
      outs = await Promise.all([
        sendQueuedEmail(created.id, deps),
        sendQueuedEmail(created.id, deps),
      ]);
    } finally {
      gate.delayMs = 0;
    }
    expect(outs).toEqual(
      expect.arrayContaining([
        { outcome: "sent" },
        { outcome: "skipped", reason: "not_claimed" },
      ]),
    );
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(1);
    expect(await events(created.id)).toEqual(["queued", "sent"]);
    expect(await load(created.id)).toMatchObject({
      status: "sent",
      attempts: 1,
    });
    await connectTeamAws("org_1", { sesMaxSendRate: 1 });
  });
});

describe("reconcileStuckSending", () => {
  async function stuck(sesMessageId: string | null, ageMs: number) {
    const created = await create();
    const { emails } = await import("@/db/schema");
    await pg.db
      .update(emails)
      .set({
        status: "sending",
        attempts: 1,
        sesMessageId,
        updatedAt: new Date(Date.now() - ageMs),
      })
      .where(eq(emails.id, created.id));
    return created.id;
  }

  it("marks a stuck row with a ses_message_id as sent, one without as failed; leaves fresh rows alone", async () => {
    const withId = await stuck("ses-lost", 11 * 60_000);
    const without = await stuck(null, 11 * 60_000);
    const fresh = await stuck(null, 60_000);
    const { reconcileStuckSending } = await import("@/services/ses-send");
    const noop = { enqueue: vi.fn(async () => "") };
    const out = await reconcileStuckSending(noop);
    expect(out.sent).toEqual([withId]);
    expect(out.failed).toEqual([without]);

    expect(await load(withId)).toMatchObject({
      status: "sent",
      sesMessageId: "ses-lost",
    });
    expect((await load(withId)).sentAt).toBeInstanceOf(Date);
    expect(await events(withId)).toEqual(["queued", "sent"]);

    const failed = await load(without);
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toBe(
      "Send did not complete (worker interrupted); not retried because SES may have accepted it.",
    );
    expect(await events(without)).toEqual(["queued", "failed"]);

    expect(await load(fresh)).toMatchObject({ status: "sending" });
    expect(await events(fresh)).toEqual(["queued"]);

    // Idempotent: a second sweep finds nothing.
    expect(await reconcileStuckSending(noop)).toEqual({ sent: [], failed: [] });
  });

  it("a reconciled failed row is overtaken by a late delivered; a real failure is not", async () => {
    const { reconcileStuckSending } = await import("@/services/ses-send");
    const { recordEvent } = await import("@/services/email-events");
    const guessed = await stuck(null, 11 * 60_000);
    await reconcileStuckSending({ enqueue: vi.fn(async () => "") });
    expect((await load(guessed)).status).toBe("failed");
    // SES had accepted it after all: the SNS Delivery wins.
    await recordEvent({
      emailId: guessed,
      teamId: "org_1",
      type: "delivered",
      dedupeKey: "sns:late-delivery",
    });
    expect((await load(guessed)).status).toBe("delivered");

    ses
      .on(SendEmailCommand)
      .rejects(awsErr("MessageRejected", "Email address is blacklisted."));
    const real = await create();
    const { sendQueuedEmail } = await import("@/services/ses-send");
    await sendQueuedEmail(real.id, { enqueue: vi.fn(async () => "") });
    await recordEvent({
      emailId: real.id,
      teamId: "org_1",
      type: "delivered",
      dedupeKey: "sns:impossible-delivery",
    });
    expect((await load(real.id)).status).toBe("failed");
  });
});

describe("sweepQueuedEmails", () => {
  it("re-enqueues due queued/scheduled rows untouched for 5 minutes; leaves fresh and future rows alone", async () => {
    const { emails } = await import("@/db/schema");
    const age = (id: string, ms: number, scheduledAt?: Date) =>
      pg.db
        .update(emails)
        .set({
          updatedAt: new Date(Date.now() - ms),
          ...(scheduledAt && { scheduledAt }),
        })
        .where(eq(emails.id, id));
    const stale = await create();
    await age(stale.id, 6 * 60_000);
    const fresh = await create();
    await age(fresh.id, 60_000);
    const dueScheduled = await create({
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await age(dueScheduled.id, 6 * 60_000, new Date(Date.now() - 1000));
    const future = await create({
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    await age(future.id, 6 * 60_000);
    const enqueue = vi.fn(async () => "");
    const { sweepQueuedEmails } = await import("@/services/ses-send");
    const ids = await sweepQueuedEmails({ enqueue });
    expect(ids).toContain(stale.id);
    expect(ids).toContain(dueScheduled.id);
    expect(ids).not.toContain(fresh.id);
    expect(ids).not.toContain(future.id);
    expect(enqueue).toHaveBeenCalledWith("email.send", { emailId: stale.id });
    expect(enqueue).toHaveBeenCalledWith("email.send", {
      emailId: dueScheduled.id,
    });
    // Only still-sendable rows are ever swept: settled ones never appear.
    for (const id of ids)
      expect((await load(id)).status).toMatch(/^(queued|scheduled)$/);
  });

  it("does not sweep a row a worker just throttled or deferred (updated_at is touched)", async () => {
    const { emails } = await import("@/db/schema");
    const { resetRateForTests } = await import("@/services/send-limits");
    const { sendQueuedEmail, sweepQueuedEmails } =
      await import("@/services/ses-send");
    const now = new Date();
    const enqueue = vi.fn(async () => "");
    const stale = (id: string, extra: object = {}) =>
      pg.db
        .update(emails)
        .set({ updatedAt: new Date(now.getTime() - 10 * 60_000), ...extra })
        .where(eq(emails.id, id));
    // Empty bucket: the attempt is throttled.
    await resetRateForTests("org_1", now);
    const throttled = await create();
    await stale(throttled.id);
    expect(await sendQueuedEmail(throttled.id, { enqueue, now })).toMatchObject(
      { outcome: "throttled" },
    );
    // Not due for an hour: the attempt is deferred.
    const deferred = await create({
      scheduledAt: new Date(now.getTime() + 3600_000).toISOString(),
    });
    await stale(deferred.id);
    expect(await sendQueuedEmail(deferred.id, { enqueue, now })).toMatchObject({
      outcome: "deferred",
    });
    for (const id of [throttled.id, deferred.id])
      expect((await load(id)).updatedAt.getTime()).toBeGreaterThanOrEqual(
        now.getTime(),
      );
    const ids = await sweepQueuedEmails(
      { enqueue },
      new Date(now.getTime() + 4 * 60_000),
    );
    expect(ids).not.toContain(throttled.id);
    expect(ids).not.toContain(deferred.id);
  });
});
