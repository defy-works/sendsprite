import { z } from "zod";

/**
 * Request/response contracts for `/api/v1/emails` (spec §7). Shared with the
 * SDK, so this file must stay free of server-only imports.
 */

// "Name <a@b>" or "a@b". Shape check only; display names and normalisation
// are handled server-side (`@/lib/email-address`).
const ADDR_SPEC = '[^\\s@<>"]+@[^\\s@<>"]+\\.[^\\s@<>"]+';
const ADDR_RE = new RegExp(`^(?:[^<>]*<${ADDR_SPEC}>|${ADDR_SPEC})$`);
const NO_CRLF = /^[^\r\n]*$/;
const noCrlf = (s: z.ZodString) =>
  s.regex(NO_CRLF, { message: "must not contain line breaks" });
const addr = noCrlf(z.string().trim().min(3).max(320)).regex(ADDR_RE, {
  message: "invalid email address",
});
const list = z
  .union([addr, z.array(addr)])
  .default([])
  .transform((v) => (Array.isArray(v) ? v : [v]));

// Headers Sendsprite/SES set themselves; user-supplied values are rejected.
// `list-unsubscribe` is deliberately allowed.
const RESERVED = new Set([
  "to",
  "cc",
  "bcc",
  "from",
  "subject",
  "reply-to",
  "content-type",
  "mime-version",
  "date",
  "message-id",
  "return-path",
  "sender",
  "dkim-signature",
  "received",
  "content-transfer-encoding",
  "authentication-results",
]);
const HEADER_NAME = /^[A-Za-z0-9-]{1,80}$/;
const TAG_KEY = /^[A-Za-z0-9_-]+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const MAX_TAGS = 20;

export const AttachmentInput = z.object({
  filename: noCrlf(z.string().min(1).max(255)).refine((f) => !/[\\/]/.test(f), {
    message: "filename must not contain path separators",
  }),
  content: z
    .string()
    .min(1)
    .transform((s) => s.replace(/\s+/g, ""))
    .refine((s) => s.length > 0 && BASE64.test(s), {
      message: "content must be base64",
    }),
  contentType: noCrlf(z.string().max(255)).optional(),
});
export type AttachmentInput = z.infer<typeof AttachmentInput>;

export const MAX_RECIPIENTS = 50;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const SendEmailInput = z
  .object({
    from: addr,
    to: z
      .union([addr, z.array(addr).min(1)])
      .transform((v) => (Array.isArray(v) ? v : [v])),
    cc: list,
    bcc: list,
    replyTo: list,
    subject: noCrlf(z.string().min(1).max(998)),
    html: z.string().max(5_000_000).optional(),
    text: z.string().max(5_000_000).optional(),
    template: z.string().min(1).max(64).optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
    headers: z
      .record(
        z.string().regex(HEADER_NAME, { message: "invalid header name" }),
        noCrlf(z.string().max(1000)),
      )
      .default({})
      .refine(
        (h) => !Object.keys(h).some((k) => RESERVED.has(k.toLowerCase())),
        { message: "headers contains a reserved header" },
      ),
    attachments: z
      .array(AttachmentInput)
      .max(20)
      .default([])
      .refine(
        (a) =>
          a.reduce((n, x) => n + Math.floor((x.content.length * 3) / 4), 0) <=
          MAX_ATTACHMENT_BYTES,
        { message: "attachments exceed 10 MB" },
      ),
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
    tags: z
      .record(
        z
          .string()
          .min(1)
          .max(64)
          .regex(TAG_KEY, { message: "invalid tag key" }),
        noCrlf(z.string().max(256)),
      )
      .default({})
      .refine((t) => Object.keys(t).length <= MAX_TAGS, {
        message: `at most ${MAX_TAGS} tags`,
      }),
    idempotencyKey: z.string().min(1).max(256).optional(),
    trackOpens: z.boolean().optional(),
    trackClicks: z.boolean().optional(),
    overrideSuppression: z.boolean().optional(),
  })
  .refine((v) => v.html || v.text || v.template, {
    message: "one of html, text or template is required",
  })
  .refine((v) => v.to.length + v.cc.length + v.bcc.length <= MAX_RECIPIENTS, {
    message: `at most ${MAX_RECIPIENTS} recipients`,
  });
export type SendEmailInput = z.infer<typeof SendEmailInput>;

export const BatchSendInput = z.array(SendEmailInput).min(1).max(100);
export type BatchSendInput = z.infer<typeof BatchSendInput>;

export const EMAIL_STATUS = [
  "queued",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "cancelled",
] as const;
export type EmailStatus = (typeof EMAIL_STATUS)[number];

export const EmailObject = z.object({
  id: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  replyTo: z.array(z.string()),
  subject: z.string(),
  status: z.enum(EMAIL_STATUS),
  scheduledAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
  tags: z.record(z.string(), z.string()),
  lastError: z.string().nullable(),
});
export type EmailObject = z.infer<typeof EmailObject>;

export const EmailEventObject = z.object({
  id: z.string(),
  type: z.string(),
  occurredAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type EmailEventObject = z.infer<typeof EmailEventObject>;

export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
  status: z.enum(EMAIL_STATUS).optional(),
  to: z.string().optional(),
  domainId: z.string().optional(),
  tag: z.string().optional(),
});
export type ListQuery = z.infer<typeof ListQuery>;
