import { describe, expect, it } from "vitest";
import { parseSesEvent } from "@/lib/ses-events";

// Fixture shapes follow the SES event publishing docs.
const mail = {
  timestamp: "2026-08-25T10:00:00.000Z",
  messageId: "ses-msg-1",
  source: "a@mail.acme.com",
  destination: ["r@x.io"],
  tags: {
    ss_email: ["em_1"],
    ss_team: ["org_1"],
    "ses:configuration-set": ["sendsprite"],
  },
};

describe("parseSesEvent", () => {
  it("maps Delivery", () => {
    expect(
      parseSesEvent({
        eventType: "Delivery",
        mail,
        delivery: {
          timestamp: "2026-08-25T10:00:05.000Z",
          recipients: ["r@x.io"],
          smtpResponse: "250 ok",
          processingTimeMillis: 500,
        },
      }),
    ).toMatchObject({
      type: "delivered",
      emailId: "em_1",
      teamId: "org_1",
      sesMessageId: "ses-msg-1",
      recipients: ["r@x.io"],
      occurredAt: new Date("2026-08-25T10:00:05.000Z"),
    });
  });
  it("maps Permanent bounce with suppression hint", () => {
    const e = parseSesEvent({
      eventType: "Bounce",
      mail,
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "r@x.io", diagnosticCode: "550" }],
        timestamp: "2026-08-25T10:00:06.000Z",
        feedbackId: "fb1",
      },
    });
    expect(e).toMatchObject({
      type: "bounced",
      suppress: [{ email: "r@x.io", reason: "bounce" }],
      payload: { bounceType: "Permanent", bounceSubType: "General" },
    });
  });
  it("Transient bounce does not suppress", () => {
    expect(
      parseSesEvent({
        eventType: "Bounce",
        mail,
        bounce: {
          bounceType: "Transient",
          bounceSubType: "MailboxFull",
          bouncedRecipients: [{ emailAddress: "r@x.io" }],
          timestamp: mail.timestamp,
          feedbackId: "fb2",
        },
      })!.suppress,
    ).toEqual([]);
  });
  it("maps Complaint, Send, Reject, DeliveryDelay, Open, Click, Rendering Failure", () => {
    expect(
      parseSesEvent({
        eventType: "Complaint",
        mail,
        complaint: {
          complainedRecipients: [{ emailAddress: "R@x.io" }],
          timestamp: mail.timestamp,
          feedbackId: "c1",
          complaintFeedbackType: "abuse",
        },
      }),
    ).toMatchObject({
      type: "complained",
      suppress: [{ email: "r@x.io", reason: "complaint" }],
    });
    expect(parseSesEvent({ eventType: "Send", mail, send: {} })!.type).toBe(
      "sent",
    );
    expect(
      parseSesEvent({
        eventType: "Reject",
        mail,
        reject: { reason: "Bad content" },
      }),
    ).toMatchObject({ type: "rejected", payload: { reason: "Bad content" } });
    expect(
      parseSesEvent({
        eventType: "DeliveryDelay",
        mail,
        deliveryDelay: {
          delayType: "MailboxFull",
          timestamp: mail.timestamp,
          delayedRecipients: [{ emailAddress: "r@x.io" }],
        },
      })!.type,
    ).toBe("delivery_delayed");
    expect(
      parseSesEvent({
        eventType: "Open",
        mail,
        open: {
          ipAddress: "1.2.3.4",
          timestamp: mail.timestamp,
          userAgent: "ua",
        },
      })!.type,
    ).toBe("opened");
    expect(
      parseSesEvent({
        eventType: "Click",
        mail,
        click: {
          link: "https://x",
          timestamp: mail.timestamp,
          ipAddress: "1.2.3.4",
          userAgent: "ua",
        },
      })!.type,
    ).toBe("clicked");
    expect(
      parseSesEvent({
        eventType: "Rendering Failure",
        mail,
        failure: { templateName: "t", errorMessage: "e" },
      })!.type,
    ).toBe("failed");
  });
  it("accepts the legacy notificationType field", () => {
    expect(
      parseSesEvent({
        notificationType: "Bounce",
        mail,
        bounce: {
          bounceType: "Permanent",
          bounceSubType: "General",
          bouncedRecipients: [{ emailAddress: "r@x.io" }],
          timestamp: mail.timestamp,
          feedbackId: "fb3",
        },
      }),
    ).toMatchObject({ type: "bounced", payload: { eventType: "Bounce" } });
  });
  it("falls back to messageId when tags are missing and returns null for unknown types", () => {
    expect(
      parseSesEvent({
        eventType: "Delivery",
        mail: { ...mail, tags: {} },
        delivery: { timestamp: mail.timestamp, recipients: [] },
      }),
    ).toMatchObject({ emailId: null, teamId: null, sesMessageId: "ses-msg-1" });
    expect(
      parseSesEvent({ eventType: "Subscription", mail, subscription: {} }),
    ).toBeNull();
    expect(parseSesEvent({ eventType: "Delivery", delivery: {} })).toBeNull();
    expect(parseSesEvent({ nope: 1 })).toBeNull();
    expect(parseSesEvent(null)).toBeNull();
  });
});
