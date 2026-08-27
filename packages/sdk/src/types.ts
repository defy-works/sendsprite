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

/**
 * Body of `POST /emails`. Exactly one content source: `html`/`text`, or a
 * `template` (which may not be combined with either).
 */
export interface SendEmailInput {
  /** `"Name <addr@domain>"` or a bare address on a verified domain. */
  from: string;
  to: AddressList;
  cc?: AddressList;
  bcc?: AddressList;
  replyTo?: AddressList;
  /** Required unless `template` is set; a subject here overrides the template's. */
  subject?: string;
  html?: string;
  text?: string;
  /** Slug (or id) of a stored template, rendered server-side with `variables`. */
  template?: string;
  /** Values for the template's `{{placeholders}}`; only valid with `template`. */
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

// ---- templates --------------------------------------------------------------

export type TemplateVariableType = "string" | "number" | "boolean";

/** One declared variable. A `default` is what makes a placeholder optional. */
export interface TemplateVariable {
  name: string;
  /** Default `"string"`. */
  type?: TemplateVariableType;
  /** The only way to make a placeholder optional; there is no `required` flag. */
  default?: string | number | boolean;
  description?: string;
}

/**
 * A declared variable as the API stores it: `type` has been resolved to its
 * default, so it is always present. `default` and `description` stay optional
 * — a variable that declares neither has neither.
 */
export interface DeclaredTemplateVariable {
  name: string;
  type: TemplateVariableType;
  default?: string | number | boolean;
  description?: string;
}

export interface TemplateVariablesSchema {
  variables?: TemplateVariable[];
}

export interface CreateTemplateInput {
  /** Lower-case, digits and dashes; the name `emails.send({ template })` uses. */
  slug: string;
  name: string;
  /** May contain `{{ variable }}` placeholders. */
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  variablesSchema?: TemplateVariablesSchema;
}

/** At least one field. `slug` cannot change — a rename is a create plus a delete. */
export interface UpdateTemplateInput {
  name?: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string | null;
  variablesSchema?: TemplateVariablesSchema;
}

export interface TemplateObject {
  id: string;
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variablesSchema: { variables: DeclaredTemplateVariable[] };
  /** Bumped on every content change; each one is kept in the history. */
  version: number;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateVersionObject {
  version: number;
  snapshot: {
    name: string;
    subject: string;
    bodyHtml: string;
    bodyText: string | null;
    variablesSchema: { variables: DeclaredTemplateVariable[] };
  };
  createdBy: string | null;
  createdAt: string;
}

/** `GET /templates/:slug`: the template plus its versions, newest first. */
export interface TemplateDetail extends TemplateObject {
  versions: TemplateVersionObject[];
}

export interface RenderTemplateInput {
  variables?: Record<string, unknown>;
}

/**
 * `POST /templates/:slug/render`. The rendered fields and nothing else — the
 * variables that produced them are not echoed back.
 */
export interface RenderedTemplateObject {
  subject: string;
  html: string;
  text: string | null;
}

// ---- contacts ---------------------------------------------------------------

export interface CreateContactBookInput {
  name: string;
  /** `"Name <addr@domain>"` or a bare address; a suggestion, not a sender. */
  defaultFrom?: string;
}

/** At least one field. */
export interface UpdateContactBookInput {
  name?: string;
  defaultFrom?: string | null;
}

export interface ContactBookObject {
  id: string;
  name: string;
  defaultFrom: string | null;
  contactCount: number;
  subscribedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateContactInput {
  email: string;
  firstName?: string;
  lastName?: string;
  /** Up to 20 string properties, 500 characters each. */
  properties?: Record<string, string>;
  /** Default `true`. */
  subscribed?: boolean;
}

/** At least one field. */
export interface UpdateContactInput {
  firstName?: string | null;
  lastName?: string | null;
  properties?: Record<string, string>;
  subscribed?: boolean;
  unsubscribeReason?: string | null;
}

export interface ContactObject {
  id: string;
  bookId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  properties: Record<string, string>;
  /**
   * Consent, not deliverability. `false` stops campaigns, **not** transactional
   * sends — `suppressions` is what blocks an address entirely.
   */
  subscribed: boolean;
  unsubscribeReason: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Filters for `contacts.list` / `contacts.iterate`. */
export interface ListContactsParams extends PageParams {
  /** Matches an address prefix or either name. */
  q?: string;
  subscribed?: boolean;
}

export interface ImportContactsInput {
  /** Up to 2 MB; needs an `email` column. */
  csv: string;
  /** Default `true`. */
  updateExisting?: boolean;
}

/**
 * The report `contactBooks.import()` resolves with. Rows that failed do not
 * fail the call: the good rows land, and the bad ones are counted here with
 * the line each was on (the first 100).
 */
export interface ImportContactsResult {
  imported: number;
  updated: number;
  skipped: number;
  /** Rows dropped because a later row in the same file had the same address. */
  duplicates: number;
  errors: { line: number; email: string | null; reason: string }[];
}

export interface UnsubscribeContactInput {
  email: string;
  /** Narrow to one book; omitted means every book of the team. */
  bookId?: string;
  reason?: string;
}

export interface UnsubscribeResult {
  /** Contact rows changed; 0 when the address was already out. */
  unsubscribed: number;
}

// ---- campaigns --------------------------------------------------------------

export type CampaignStatus =
  "draft" | "scheduled" | "sending" | "sent" | "cancelled";

/** Horizontal placement of a block's contents. */
export type BlockAlign = "left" | "center" | "right";

/**
 * `#rrggbb`, upper or lower case.
 *
 * Typed as `string` because TypeScript cannot express the pattern, but the API
 * checks it: `red`, `rgb(0,0,0)` and `var(--brand)` are all valid CSS and all
 * `validation_error` here. These values are interpolated into an email's
 * `style` attributes, where a colour is the only thing that can be safe.
 */
export type HexColor = string;

/** Corner rounding, as a preset rather than a radius. */
export type CornerStyle = "sharp" | "soft" | "pill";

/**
 * Where a column's contents sit when the columns are unequal in height.
 *
 * A row's cells are as tall as the tallest, so a short caption beside a tall
 * image had nowhere to go but the top.
 */
export type VerticalAlign = "top" | "middle" | "bottom";

/** A rule's line. */
export type DividerStyle = "solid" | "dashed" | "dotted";

/** A button's padding and type size, as three steps. */
export type ButtonSize = "small" | "medium" | "large";

/** Image width as a percentage of its container. Quarters only. */
export type ImageWidth = 25 | 50 | 75 | 100;

/**
 * Vertical space a block carries with it, in pixels, 0–96.
 *
 * Distinct from the spacer block, which is space *as* content — this is the
 * room a block needs around itself, and it does not survive as a block of its
 * own when the one it belongs to is moved or deleted.
 */
export interface BlockSpacing {
  spaceTop?: number;
  spaceBottom?: number;
}

/** One of three sizes; the renderer maps each level to a fixed style. */
export interface HeadingBlock extends BlockSpacing {
  kind: "heading";
  level: 1 | 2 | 3;
  text: string;
  align?: BlockAlign;
  color?: HexColor;
}

/**
 * A paragraph, and the only campaign field that reaches an inbox as markup.
 * It may carry `<strong>`, `<em>`, `<br>` and `<a href>` pointing at
 * `http(s)`/`mailto` — every tag closed, no anchor inside an anchor. Anything
 * else is a `validation_error`, not sanitised-away markup.
 */
export interface TextBlock extends BlockSpacing {
  kind: "text";
  html: string;
  align?: BlockAlign;
  color?: HexColor;
}

/** A call to action, rendered as a button that survives Outlook. */
export interface ButtonBlock extends BlockSpacing {
  kind: "button";
  label: string;
  /** Absolute `http(s)`/`mailto`. A URL carrying credentials is refused. */
  url: string;
  align?: BlockAlign;
  /** The button itself. */
  color?: HexColor;
  /** The label on it. */
  textColor?: HexColor;
  corners?: CornerStyle;
  /** Stretches to the container width — useful inside a narrow column. */
  fullWidth?: boolean;
  size?: ButtonSize;
}

export interface ImageBlock extends BlockSpacing {
  kind: "image";
  url: string;
  /** Required: most clients block images until the reader asks for them. */
  alt: string;
  /** Wraps the image in a link. */
  href?: string;
  align?: BlockAlign;
  /** Percentage of the container. Defaults to the full width. */
  width?: ImageWidth;
  corners?: CornerStyle;
}

/** A horizontal rule. */
export interface DividerBlock extends BlockSpacing {
  kind: "divider";
  color?: HexColor;
  /** Line weight in pixels, 1–8. */
  weight?: number;
  /** Named `lineStyle`, not `style`: a block never carries a style attribute. */
  lineStyle?: DividerStyle;
  /** Percentage of the container, so a rule can be a short centred flourish. */
  width?: ImageWidth;
}

/** Vertical whitespace, 4–96 pixels. */
export interface SpacerBlock {
  kind: "spacer";
  size: number;
}

/**
 * A block that can sit inside a column: everything except a row of columns.
 *
 * The recursion stops at one level deliberately. Nested column tables are
 * where email layout stops being portable — the Word engine behind Outlook on
 * Windows measures an inner table against the wrong containing block — so the
 * API refuses the shape rather than shipping a body that renders differently
 * for a third of recipients.
 */
export type LeafBlock =
  | HeadingBlock
  | TextBlock
  | ButtonBlock
  | ImageBlock
  | DividerBlock
  | SpacerBlock;

/**
 * Column ratios, as presets. The name is the ratio, so `"2-1"` is a wide
 * column then a narrow one. `columns.length` must match: `"1-1-1"` with two
 * columns is a `validation_error`, not a row with an empty cell.
 *
 * `"1"` is a row of one column — a band across the email holding a single
 * stack. It is what the dashboard wraps every ordinary block in, so that a
 * paragraph can carry a background, a vertical alignment and space of its own.
 */
export type ColumnLayout = "1" | "1-1" | "1-1-1" | "2-1" | "1-2";

/** A row of one, two or three columns. At most 20 blocks per column. */
export interface ColumnsBlock extends BlockSpacing {
  kind: "columns";
  layout: ColumnLayout;
  /** Fills the row behind every column. */
  background?: HexColor;
  /** The gutter between columns, in pixels, 0–48. Defaults to 16. */
  gap?: number;
  /** Applies to every cell in the row. Defaults to `top`. */
  verticalAlign?: VerticalAlign;
  columns: LeafBlock[][];
}

/** One block of a campaign body, discriminated on `kind`. */
export type CampaignBlock = LeafBlock | ColumnsBlock;

/**
 * The card width in pixels, as three presets.
 *
 * 600 is what fits an Outlook reading pane at 96 dpi; 480 and 720 are the
 * narrow and wide departures from it.
 */
export type ContentWidth = 480 | 600 | 720;

/**
 * A font *family*, not a font. A webfont is one most clients will not load, so
 * the only honest choice is which system stack to fall back to.
 */
export type FontFamily = "sans" | "serif" | "mono";

/**
 * What the whole body looks like, as opposed to one block in it.
 *
 * Every field is optional and every one has a renderer default, so an absent
 * theme renders exactly what a body rendered before themes existed. A client
 * that never sends one is not opting out of anything.
 */
export interface CampaignTheme {
  /** Behind the card. Defaults to a light grey. */
  pageBackground?: HexColor;
  /** The card itself. Defaults to white. */
  cardBackground?: HexColor;
  contentWidth?: ContentWidth;
  font?: FontFamily;
  /** Body and heading text. Defaults to near-black. */
  textColor?: HexColor;
  /**
   * Links inside `text` blocks. Applied through a `<style>` rule, which Gmail,
   * Apple Mail and Outlook.com honour; Outlook on Windows keeps its own blue.
   */
  linkColor?: HexColor;
  cardCorners?: CornerStyle;
  /**
   * The card's inner gutter, in pixels, 0–64. Defaults to 24, and is what
   * every block's left and right edge is set against.
   */
  contentPadding?: number;
}

/** `POST /campaigns`: a draft. Nothing here schedules or sends. */
export interface CreateCampaignInput {
  name: string;
  /** The contact book the audience is drawn from. */
  bookId: string;
  /** The verified sending domain `from` must belong to. */
  domainId: string;
  from: string;
  replyTo?: string;
  subject: string;
  /** 1–100 blocks, in the order they are rendered. */
  blocks: CampaignBlock[];
  /** Absent means the renderer's defaults. */
  theme?: CampaignTheme;
}

/**
 * At least one field. Accepted while a campaign is `draft` or `scheduled` and
 * refused after that — the body of a send in flight cannot change under it.
 */
export interface UpdateCampaignInput {
  name?: string;
  bookId?: string;
  domainId?: string;
  from?: string;
  /** `null` clears it; omitting it leaves it alone. */
  replyTo?: string | null;
  subject?: string;
  blocks?: CampaignBlock[];
  /** `null` resets to the defaults; omitting it leaves the theme alone. */
  theme?: CampaignTheme | null;
}

/**
 * Body of `POST /campaigns/:id/schedule`. An absent `scheduledAt` means "start
 * now" on the wire; in this SDK that case is `campaigns.sendNow()`, so
 * `campaigns.schedule()` always fills this in.
 */
export interface ScheduleCampaignInput {
  /** ISO 8601 with an offset, in the future. */
  scheduledAt?: string;
}

/**
 * Per-campaign tallies. Derived from the mail log rather than incremented per
 * event, so they never drift from `emails` — and may trail a send by a moment.
 */
export interface CampaignCounts {
  recipients: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  bounced: number;
  complained: number;
  failed: number;
}

export interface CampaignObject {
  id: string;
  name: string;
  bookId: string;
  domainId: string;
  from: string;
  replyTo: string | null;
  subject: string;
  blocks: CampaignBlock[];
  /** `null` when the campaign renders with the defaults. */
  theme: CampaignTheme | null;
  status: CampaignStatus;
  scheduledAt: string | null;
  /** When the fan-out finished, not when it started. */
  sentAt: string | null;
  counts: CampaignCounts;
  createdAt: string;
  updatedAt: string;
}

/** Filters for `campaigns.list` / `campaigns.iterate`. */
export interface ListCampaignsParams extends PageParams {
  status?: CampaignStatus;
}

/**
 * What `campaigns.audience()` reports: who a send would reach if it started
 * now.
 *
 * `eligible` is the only number that will actually be mailed, and it is the
 * intersection of the other two rules rather than either of them —
 * `subscribed` is consent, `suppressed` is deliverability, and a contact has
 * to clear both.
 */
export interface AudiencePreview {
  contacts: number;
  subscribed: number;
  suppressed: number;
  /** Subscribed **and** not suppressed. */
  eligible: number;
}
