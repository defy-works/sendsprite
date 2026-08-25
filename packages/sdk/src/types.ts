/**
 * Public types of the `sendsprite` package.
 *
 * These mirror the zod contracts in `@sendsprite/shared` but are written as
 * plain TypeScript so the emitted `.d.ts` depends on nothing (shared is a
 * private workspace package and its inferred types would drag `zod` in).
 * `tests/types-parity.test.ts` asserts they stay in sync with the schemas:
 * inputs against `z.input`, objects against `z.output`.
 */

/**
 * Structural stand-in for React's `ReactElement`. The root entry must be
 * usable without `@types/react` installed (React is an *optional* peer), so
 * `dist/index.d.ts` may not carry a React module specifier. Anything React
 * produces satisfies this shape; `sendsprite/react`'s `renderEmail` keeps the
 * real `ReactElement` parameter type for authors who do have the types.
 */
export type ReactElementLike = {
  type: unknown;
  props: unknown;
  key?: string | null;
};

// ---- errors -----------------------------------------------------------------

/** Machine-readable `error.code` values of the REST API. */
export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "domain_not_verified"
  | "suppressed_recipient"
  | "rate_limited"
  | "daily_quota_exceeded"
  | "monthly_quota_exceeded"
  | "sandbox_restricted"
  | "idempotency_conflict"
  | "conflict"
  | "payload_too_large"
  | "not_configured"
  | "internal_error";

// ---- pagination -------------------------------------------------------------

/** `{ data, nextCursor }` envelope returned by every list endpoint. */
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Cursor pagination parameters accepted by every list endpoint. */
export interface PageParams {
  /** Page size, 1–100 (server default 25). */
  limit?: number;
  /** `nextCursor` from the previous page. */
  cursor?: string;
}

// ---- emails -----------------------------------------------------------------

export type EmailStatus =
  | "queued"
  | "scheduled"
  | "sending"
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "cancelled";

export type EmailEventType =
  | "queued"
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "rejected"
  | "opened"
  | "clicked"
  | "failed"
  | "cancelled";

/** One address or a list; the server normalises to a list. */
export type AddressList = string | string[];

export interface AttachmentInput {
  /** File name shown to the recipient; no path separators. */
  filename: string;
  /** Base64 content (whitespace tolerated). */
  content: string;
  contentType?: string;
}

/** Body of `POST /emails`. One of `html`, `text` or `template` is required. */
export interface SendEmailInput {
  /** `"Name <addr@domain>"` or a bare address on a verified domain. */
  from: string;
  to: AddressList;
  cc?: AddressList;
  bcc?: AddressList;
  replyTo?: AddressList;
  subject: string;
  html?: string;
  text?: string;
  template?: string;
  variables?: Record<string, unknown>;
  /** Custom headers; reserved names (`to`, `date`, `message-id`, …) are rejected. */
  headers?: Record<string, string>;
  /** Up to 20, 10 MB total. */
  attachments?: AttachmentInput[];
  /** ISO 8601 with offset; must be in the future. */
  scheduledAt?: string;
  /** Up to 20 key/value pairs. */
  tags?: Record<string, string>;
  /** A replay with the same key returns the original email id; no expiry. */
  idempotencyKey?: string;
  trackOpens?: boolean;
  trackClicks?: boolean;
  overrideSuppression?: boolean;
}

/** Body of `POST /emails/batch`: 1–100 sends. */
export type BatchSendInput = SendEmailInput[];

/**
 * `emails.send()` input: a `SendEmailInput` plus an optional `react` element,
 * rendered client-side to `html`/`text` (explicit `html`/`text` win) before posting.
 * Requires the optional peers `react` and `@react-email/render`.
 */
export type SendEmailOptions = SendEmailInput & { react?: ReactElementLike };

/** `emails.batch()` input: 1–100 `SendEmailOptions`. */
export type BatchSendOptions = SendEmailOptions[];

export interface EmailObject {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  status: EmailStatus;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
  tags: Record<string, string>;
  lastError: string | null;
}

export interface EmailEventObject {
  id: string;
  type: EmailEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** `GET /emails/:id`: the email plus its timeline, oldest first. */
export interface EmailDetail extends EmailObject {
  events: EmailEventObject[];
}

/** `PATCH /emails/:id`: move a `scheduled` email to a new future time. */
export interface PatchEmailInput {
  scheduledAt: string;
}

/** Filters for `emails.list` / `emails.iterate`. */
export interface ListEmailsParams extends PageParams {
  status?: EmailStatus;
  to?: string;
  domainId?: string;
  tag?: string;
}

// ---- domains ----------------------------------------------------------------

export type DomainStatus = "pending" | "verified" | "failed";
export type DnsMode = "auto" | "manual";
export type DnsRecordKind = "DKIM" | "MAIL_FROM_MX" | "MAIL_FROM_SPF" | "DMARC";

export interface CreateDomainInput {
  /** e.g. `mail.example.com` (lower-cased, trailing dot stripped). */
  name: string;
}

export interface DnsRecordObject {
  kind: DnsRecordKind;
  type: "CNAME" | "MX" | "TXT";
  name: string;
  value: string;
  priority: number | null;
  /** Whether the record currently resolves as expected. */
  ok: boolean;
}

export interface DomainObject {
  id: string;
  name: string;
  status: DomainStatus;
  /** `auto` when a connected Cloudflare zone manages the records. */
  dnsMode: DnsMode;
  region: string;
  records: DnsRecordObject[];
  lastError: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

// ---- api keys ---------------------------------------------------------------

export type ApiKeyPermission = "full" | "sending_only";

export interface CreateApiKeyInput {
  name: string;
  /** Default `full`. */
  permission?: ApiKeyPermission;
  /** Restrict the key to one sending domain. */
  domainId?: string;
}

export interface ApiKeyObject {
  id: string;
  name: string;
  permission: ApiKeyPermission;
  keyPrefix: string;
  domainId: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Returned once, by `POST /api-keys`. */
export interface ApiKeyCreated {
  id: string;
  secret: string;
}

// ---- webhooks ---------------------------------------------------------------

export type WebhookEventType =
  | "email.sent"
  | "email.delivered"
  | "email.delayed"
  | "email.bounced"
  | "email.complained"
  | "email.opened"
  | "email.clicked"
  | "email.failed"
  | "contact.created"
  | "contact.updated"
  | "contact.unsubscribed"
  | "contact.resubscribed"
  | "domain.verified"
  | "domain.failed"
  | "campaign.sent"
  | "campaign.completed";

/** JSON body delivered to a webhook endpoint. */
export interface WebhookPayload<T = Record<string, unknown>> {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  data: T;
}

export interface CreateWebhookInput {
  /** https only. */
  url: string;
  /** Non-empty. */
  events: WebhookEventType[];
}

/** At least one field. */
export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookEventType[];
  enabled?: boolean;
}

export interface WebhookObject {
  id: string;
  url: string;
  events: WebhookEventType[];
  enabled: boolean;
  disabledReason: string | null;
  failingSince: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Returned once, by `POST /webhooks`. */
export interface WebhookCreated {
  id: string;
  secret: string;
}

/** `POST /webhooks/:id/test` → 202. */
export interface WebhookTestAccepted {
  deliveryId: string;
}

// ---- suppressions -----------------------------------------------------------

export type SuppressionReason =
  "bounce" | "complaint" | "manual" | "unsubscribe";

export interface AddSuppressionInput {
  email: string;
  /** Default `manual`. */
  reason?: "manual" | "unsubscribe";
  note?: string;
}

export interface SuppressionObject {
  id: string;
  email: string;
  reason: SuppressionReason;
  note: string | null;
  sourceEmailId: string | null;
  createdAt: string;
}

// ---- stats / me / stream ----------------------------------------------------

/** `GET /stats`: sends and 30-day rates, plus SES account-health alerts. */
export interface SendStatsObject {
  sent: { today: number; d7: number; d30: number };
  rates: { delivered: number; bounced: number; complained: number };
  alerts: {
    kind: "bounce" | "complaint";
    level: "warning" | "critical";
    rate: number;
    window: "24h";
  }[];
}

/** `GET /me`: what the bearer key can see about itself. */
export interface MeObject {
  team: { id: string; name: string };
  apiKey: {
    id: string;
    name: string;
    permission: ApiKeyPermission;
    keyPrefix: string;
    domainId: string | null;
  };
}

/** One `change` event on the live stream. */
export interface StreamChange {
  type: "email" | "webhook";
  id?: string;
}
