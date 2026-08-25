import type { EmailEventType } from "@/db/schema/email-events";

/**
 * Normalises an SES event-publishing / notification JSON object (the SNS
 * `Message` body) into the shape the ingestion service stores. Pure.
 */
export interface NormalisedSesEvent {
  type: EmailEventType;
  emailId: string | null; // from EmailTags `ss_email`
  teamId: string | null; // from EmailTags `ss_team`
  sesMessageId: string;
  recipients: string[]; // normalised
  occurredAt: Date;
  payload: Record<string, unknown>;
  suppress: { email: string; reason: "bounce" | "complaint" }[];
}

const TYPE_MAP: Record<string, EmailEventType> = {
  Send: "sent",
  Delivery: "delivered",
  Bounce: "bounced",
  Complaint: "complained",
  Reject: "rejected",
  Open: "opened",
  Click: "clicked",
  "Rendering Failure": "failed",
  DeliveryDelay: "delivery_delayed",
};

type Loose = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const first = (v: unknown): string | null =>
  Array.isArray(v)
    ? typeof v[0] === "string"
      ? v[0]
      : null
    : typeof v === "string"
      ? v
      : null;
const lower = (s: unknown) => String(s).trim().toLowerCase();
const addresses = (xs: unknown): string[] | undefined =>
  Array.isArray(xs)
    ? xs
        .map((x: Loose) => (typeof x === "string" ? x : x?.emailAddress))
        .filter((x): x is string => typeof x === "string")
    : undefined;

function detailOf(r: Loose): Record<string, unknown> {
  const b = r.bounce,
    c = r.complaint,
    d = r.delivery,
    dd = r.deliveryDelay;
  if (b)
    return {
      bounceType: b.bounceType,
      bounceSubType: b.bounceSubType,
      diagnosticCode: b.bouncedRecipients?.[0]?.diagnosticCode ?? null,
      feedbackId: b.feedbackId,
    };
  if (c)
    return {
      complaintFeedbackType: c.complaintFeedbackType ?? null,
      complaintSubType: c.complaintSubType ?? null,
      feedbackId: c.feedbackId,
    };
  if (d)
    return {
      smtpResponse: d.smtpResponse,
      processingTimeMillis: d.processingTimeMillis,
      reportingMTA: d.reportingMTA,
    };
  if (dd) return { delayType: dd.delayType, expirationTime: dd.expirationTime };
  if (r.reject) return { reason: r.reject.reason };
  if (r.open)
    return {
      ipAddress: r.open.ipAddress,
      userAgent: r.open.userAgent,
      isBotEvent: r.open.isBotEvent,
    };
  if (r.click)
    return {
      link: r.click.link,
      ipAddress: r.click.ipAddress,
      userAgent: r.click.userAgent,
      linkTags: r.click.linkTags,
    };
  if (r.failure)
    return {
      templateName: r.failure.templateName,
      errorMessage: r.failure.errorMessage,
    };
  return {};
}

/** Returns null for non-SES payloads and event types we do not track. */
export function parseSesEvent(raw: unknown): NormalisedSesEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Loose;
  // Event publishing uses `eventType`; legacy notifications use `notificationType`.
  const eventType: unknown = r.eventType ?? r.notificationType;
  const type = typeof eventType === "string" ? TYPE_MAP[eventType] : undefined;
  const mail: Loose | undefined = r.mail;
  if (!type || !mail?.messageId) return null;
  const tags: Loose = mail.tags ?? {};
  const b = r.bounce,
    c = r.complaint,
    d = r.delivery,
    dd = r.deliveryDelay;
  const recipients = (
    addresses(b?.bouncedRecipients) ??
    addresses(c?.complainedRecipients) ??
    addresses(d?.recipients) ??
    addresses(dd?.delayedRecipients) ??
    addresses(mail.destination) ??
    []
  ).map(lower);
  const ts =
    b?.timestamp ??
    c?.timestamp ??
    d?.timestamp ??
    dd?.timestamp ??
    r.open?.timestamp ??
    r.click?.timestamp ??
    mail.timestamp;
  const suppress =
    type === "bounced" && b?.bounceType === "Permanent"
      ? recipients.map((email) => ({ email, reason: "bounce" as const }))
      : // "not-spam" is a retraction (the recipient marked it as not spam).
        type === "complained" && c?.complaintFeedbackType !== "not-spam"
        ? recipients.map((email) => ({ email, reason: "complaint" as const }))
        : [];
  const parsed = ts ? new Date(ts) : new Date();
  return {
    type,
    emailId: first(tags.ss_email),
    teamId: first(tags.ss_team),
    sesMessageId: String(mail.messageId),
    recipients,
    occurredAt: Number.isNaN(parsed.getTime()) ? new Date() : parsed,
    payload: { eventType, ...detailOf(r) },
    suppress,
  };
}
