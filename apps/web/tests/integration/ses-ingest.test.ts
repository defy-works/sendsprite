import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";
import {
  emailEvents,
  emails,
  suppressions,
  webhookDeliveries,
} from "@/db/schema";

const TOPIC = "arn:aws:sns:us-east-1:1:sendsprite-events";
// The route trusts the SNS signature check and the configured topic here;
// both have their own tests in ses-webhook.test.ts.
vi.mock("@/lib/sns-message", () => ({
  verifySnsMessage: async (raw: unknown) => raw,
}));
vi.mock("@/services/team-aws", () => ({
  getTeamAws: async (teamId: string) =>
    teamId === "org_1" ? { snsTopicArn: TOPIC } : null,
  updateTeamAws: async () => undefined,
}));
const routeEnqueue = vi.fn(async () => "");
vi.mock("@/jobs/enqueue", () => ({ enqueue: routeEnqueue }));

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
});
afterAll(async () => {
  await pg.stop();
});

const actor = {
  userId: "u1",
  teamId: "org_1",
  teamName: "Acme",
  role: "admin" as const,
};
let n = 0;
async function seed(sesMessageId: string | null = null) {
  const id = `em_test_${++n}`;
  await pg.db.insert(emails).values({
    id,
    teamId: "org_1",
    from: "a@mail.acme.com",
    fromEmail: "a@mail.acme.com",
    to: ["r@x.io"],
    subject: "s",
    status: "sent",
    sesMessageId,
    sentAt: new Date(),
  });
  return id;
}
const load = async (id: string) =>
  (await pg.db.select().from(emails).where(eq(emails.id, id)))[0]!;
const eventsOf = (id: string) =>
  pg.db.select().from(emailEvents).where(eq(emailEvents.emailId, id));

/** SES event-publishing JSON; `EmailTags` are present only when `emailId` is given. */
function ses(
  eventType: string,
  sesMessageId: string,
  emailId: string | null,
  detail: Record<string, unknown> = {},
) {
  const ts = "2026-08-25T10:00:00.000Z";
  return {
    eventType,
    mail: {
      messageId: sesMessageId,
      timestamp: ts,
      destination: ["r@x.io"],
      ...(emailId && { tags: { ss_email: [emailId], ss_team: ["org_1"] } }),
    },
    ...detail,
  };
}
const bounce = (
  sesMessageId: string,
  emailId: string | null,
  bounceType = "Permanent",
) =>
  ses("Bounce", sesMessageId, emailId, {
    bounce: {
      bounceType,
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: "r@x.io", diagnosticCode: "550" }],
      timestamp: "2026-08-25T10:00:01.000Z",
      feedbackId: "fb1",
    },
  });
const delivery = (sesMessageId: string, emailId: string | null) =>
  ses("Delivery", sesMessageId, emailId, {
    delivery: {
      timestamp: "2026-08-25T10:00:00.500Z",
      recipients: ["r@x.io"],
      smtpResponse: "250 ok",
    },
  });
const ingest = async (raw: unknown, snsId: string, teamId = "org_1") => {
  const { ingestSesEvent } = await import("@/services/ingest");
  return ingestSesEvent(teamId, raw, snsId, { enqueue });
};
const enqueue = vi.fn(async () => "");

describe("ingestSesEvent", () => {
  it("attributes by ss_email tag, records the event once, updates status, suppresses on Permanent bounce, fans out webhooks", async () => {
    const { createWebhook } = await import("@/services/webhooks");
    const w = await createWebhook(actor, {
      url: "https://hooks.acme.com/x",
      events: ["email.bounced"],
    });
    if (!w.ok) throw new Error(w.error);
    const id = await seed("ses-1");
    const msg = bounce("ses-1", id);
    expect(await ingest(msg, "sns-msg-1")).toEqual({
      ok: true,
      recorded: true,
    });
    // SNS at-least-once: a redelivery is a no-op.
    expect(await ingest(msg, "sns-msg-1")).toEqual({
      ok: true,
      recorded: false,
    });
    expect((await load(id)).status).toBe("bounced");
    const evs = await eventsOf(id);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: "bounced",
      dedupeKey: "sns:sns-msg-1",
      occurredAt: new Date("2026-08-25T10:00:01.000Z"),
      payload: {
        bounceType: "Permanent",
        diagnosticCode: "550",
        recipients: ["r@x.io"],
      },
    });
    expect(
      await pg.db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, "r@x.io")),
    ).toMatchObject([{ reason: "bounce", sourceEmailId: id }]);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [d] = await pg.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, w.data.id));
    expect(d).toMatchObject({
      eventId: evs[0]!.id,
      eventType: "email.bounced",
      payload: {
        id: evs[0]!.id,
        type: "email.bounced",
        data: {
          email: { id, status: "sent", to: ["r@x.io"] },
          event: { type: "bounced", bounceType: "Permanent" },
        },
      },
    });
    expect(JSON.stringify(d!.payload)).not.toContain('"html"');
    // Other event types are not subscribed → nothing queued.
    const id2 = await seed("ses-1b");
    expect(await ingest(delivery("ses-1b", id2), "sns-msg-1b")).toEqual({
      ok: true,
      recorded: true,
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("falls back to ses_message_id when tags are absent; unknown message → ok:false ignored", async () => {
    const id = await seed("ses-2");
    expect(await ingest(delivery("ses-2", null), "sns-msg-2")).toEqual({
      ok: true,
      recorded: true,
    });
    expect((await load(id)).status).toBe("delivered");
    expect(await ingest(delivery("ses-nope", null), "sns-msg-3")).toEqual({
      ok: false,
      reason: "unknown_email",
    });
    // A tag pointing at an email we do not have is unknown too.
    expect(await ingest(delivery("ses-2", "em_nope"), "sns-msg-4")).toEqual({
      ok: false,
      reason: "unknown_email",
    });
    expect(await ingest({ eventType: "Send" }, "sns-msg-5")).toEqual({
      ok: false,
      reason: "unparseable_or_unsupported",
    });
    expect(await ingest("nope", "sns-msg-6")).toMatchObject({ ok: false });
    // A `Send` event fills in a missing message id.
    const id3 = await seed(null);
    expect(
      await ingest(ses("Send", "ses-3", id3, { send: {} }), "sns-msg-7"),
    ).toEqual({ ok: true, recorded: true });
    expect((await load(id3)).sesMessageId).toBe("ses-3");
  });

  it("Open/Click from SES are ignored (we use our own tracking) but still ack", async () => {
    const id = await seed("ses-4");
    for (const [type, key] of [
      ["Open", "open"],
      ["Click", "click"],
    ] as const)
      expect(
        await ingest(
          ses(type, "ses-4", id, {
            [key]: { timestamp: "2026-08-25T10:01:00Z", ipAddress: "1.2.3.4" },
          }),
          `sns-${key}`,
        ),
      ).toEqual({ ok: true, recorded: false });
    expect(await eventsOf(id)).toHaveLength(0);
    expect((await load(id)).status).toBe("sent");
  });

  it("out-of-order Delivery/Bounce pairs settle on bounced either way", async () => {
    const a = await seed("ses-5");
    await ingest(delivery("ses-5", a), "sns-5a");
    await ingest(bounce("ses-5", a), "sns-5b");
    expect((await load(a)).status).toBe("bounced");
    const b = await seed("ses-6");
    await ingest(bounce("ses-6", b), "sns-6a");
    await ingest(delivery("ses-6", b), "sns-6b");
    expect((await load(b)).status).toBe("bounced");
    expect(await eventsOf(b)).toHaveLength(2);
    // A Transient bounce is recorded but does not suppress.
    await pg.db.insert(emails).values({
      id: "em_other",
      teamId: "org_1",
      from: "a@mail.acme.com",
      fromEmail: "a@mail.acme.com",
      to: ["t@x.io"],
      subject: "s",
      status: "sent",
      sesMessageId: "ses-7t",
    });
    await ingest(
      ses("Bounce", "ses-7t", "em_other", {
        bounce: {
          bounceType: "Transient",
          bounceSubType: "MailboxFull",
          bouncedRecipients: [{ emailAddress: "t@x.io" }],
          timestamp: "2026-08-25T10:00:01.000Z",
          feedbackId: "fb2",
        },
      }),
      "sns-7t",
    );
    expect(
      await pg.db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, "t@x.io")),
    ).toHaveLength(0);
  });

  it("a not-spam complaint is recorded but does not suppress", async () => {
    const id = await seed("ses-8");
    const complaint = (feedbackType: string, addr: string, snsId: string) =>
      ingest(
        ses("Complaint", "ses-8", id, {
          complaint: {
            complainedRecipients: [{ emailAddress: addr }],
            complaintFeedbackType: feedbackType,
            timestamp: "2026-08-25T10:00:02.000Z",
            feedbackId: "fb3",
          },
        }),
        snsId,
      );
    expect(await complaint("not-spam", "ns@x.io", "sns-8a")).toEqual({
      ok: true,
      recorded: true,
    });
    expect(
      await pg.db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, "ns@x.io")),
    ).toHaveLength(0);
    expect(await complaint("abuse", "ab@x.io", "sns-8b")).toEqual({
      ok: true,
      recorded: true,
    });
    expect(
      await pg.db
        .select()
        .from(suppressions)
        .where(eq(suppressions.email, "ab@x.io")),
    ).toMatchObject([{ reason: "complaint" }]);
  });

  it("POST /api/webhooks/ses/[teamId] ingests a Notification and always acks", async () => {
    const id = await seed("ses-9");
    const { POST } = await import("@/app/api/webhooks/ses/[teamId]/route");
    const post = (Message: string, MessageId: string, teamId = "org_1") =>
      POST(
        new Request(`https://mail.acme.com/api/webhooks/ses/${teamId}`, {
          method: "POST",
          headers: { "x-amz-sns-message-type": "Notification" },
          body: JSON.stringify({
            Type: "Notification",
            TopicArn: TOPIC,
            Message,
            MessageId,
            Timestamp: "2026-08-25T00:00:00Z",
          }),
        }),
        { params: Promise.resolve({ teamId }) },
      );
    expect(
      (await post(JSON.stringify(delivery("ses-9", id)), "m1")).status,
    ).toBe(200);
    expect((await load(id)).status).toBe("delivered");
    // Unknown, unsupported and non-JSON messages are acknowledged too.
    expect(
      (await post(JSON.stringify(delivery("ses-nope", null)), "m2")).status,
    ).toBe(200);
    expect((await post("not json", "m3")).status).toBe(200);
    expect(await eventsOf(id)).toHaveLength(1);
  });
});

/**
 * Every tenant runs its own AWS account and posts to its own webhook path.
 * Without a team predicate on the attribution lookup, tenant A could name
 * tenant B's email id in an `ss_email` tag and write events, status changes
 * and suppressions into B's timeline.
 */
describe("cross-tenant attribution", () => {
  it("refuses an event naming another team's email", async () => {
    await pg.db.execute(
      `insert into "organization"(id,name,slug,created_at) values ('org_2','Beta','beta',now()) on conflict do nothing`,
    );
    const victim = await seed("ses-victim");
    const before = await eventsOf(victim);

    // org_2 posts an event tagged with org_1's email id.
    expect(
      await ingest(bounce("ses-victim", victim), "sns-cross-1", "org_2"),
    ).toEqual({ ok: false, reason: "unknown_email" });

    expect(await eventsOf(victim)).toHaveLength(before.length);
    expect((await load(victim)).status).toBe("sent");
  });

  it("refuses an untagged event matched only by ses_message_id", async () => {
    const victim = await seed("ses-victim-2");
    expect(
      await ingest(bounce("ses-victim-2", null), "sns-cross-2", "org_2"),
    ).toEqual({ ok: false, reason: "unknown_email" });
    expect((await load(victim)).status).toBe("sent");
  });

  it("writes no suppression for the other team", async () => {
    const victim = await seed("ses-victim-3");
    await ingest(bounce("ses-victim-3", victim), "sns-cross-3", "org_2");
    const rows = await pg.db
      .select()
      .from(suppressions)
      .where(eq(suppressions.teamId, "org_2"));
    expect(rows).toHaveLength(0);
  });
});
