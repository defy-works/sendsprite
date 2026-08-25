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
    takeSesToken: async (now?: Date) => {
      if (gate.delayMs) await new Promise((r) => setTimeout(r, gate.delayMs));
      return mod.takeSesToken(now);
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
  const { updateInstanceSettings } =
    await import("@/services/instance-settings");
  await updateInstanceSettings(
    {
      awsMode: "keys",
      awsRegion: "eu-west-1",
      awsAccessKey: "AKIAEXAMPLE",
      awsSecret: "s3cr3t",
      sesConfigSet: "sendsprite",
      sesMaxSendRate: 1,
    },
    undefined,
    { audit: false },
  );
});
afterAll(async () => {
  await pg.stop();
});
/** Each test starts with a full bucket (rate 1, last refill well in the past). */
beforeEach(async () => {
  ses.reset();
  const { resetRateForTests } = await import("@/services/send-limits");
  await resetRateForTests(new Date(Date.now() - 10_000));
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
    await resetRateForTests(now);
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

  it("MessageRejected → failed with a failed event; no rethrow", async () => {
    ses
      .on(SendEmailCommand)
      .rejects(awsErr("MessageRejected", "Email address is blacklisted."));
    const created = await create();
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, {
      enqueue: vi.fn(async () => ""),
    });
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

  it("skips a scheduled email that is not yet due (stale job after reschedule)", async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: "never" });
    const created = await create({
      scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(created.status).toBe("scheduled");
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.id, {
      enqueue: vi.fn(async () => ""),
    });
    expect(out).toEqual({ outcome: "skipped", reason: "not_due" });
    expect(ses.commandCalls(SendEmailCommand)).toHaveLength(0);
    expect(await load(created.id)).toMatchObject({ status: "scheduled" });
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
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings({ sesMaxSendRate: 2 }, undefined, {
      audit: false,
    });
    const { resetRateForTests } = await import("@/services/send-limits");
    await resetRateForTests(new Date(Date.now() - 10_000));
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
    await updateInstanceSettings({ sesMaxSendRate: 1 }, undefined, {
      audit: false,
    });
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
    const out = await reconcileStuckSending();
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
    expect(await reconcileStuckSending()).toEqual({ sent: [], failed: [] });
  });
});
