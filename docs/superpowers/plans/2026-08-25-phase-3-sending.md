# Sendsprite Phase 3 — Sending Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A team can create an API key and send email through `POST /api/v1/emails` (single, batch, scheduled, attachments) or the SMTP relay; Sendsprite sends via SES with rate limiting, ingests SES events from SNS into a per-email timeline, maintains suppressions, delivers signed webhooks with retries, tracks opens/clicks, and shows it all in the dashboard.

**Architecture:** Request path — API key auth → zod validation (schemas in `packages/shared`, reused by the Phase 4 SDK) → `services/emails.ts` writes the `emails` row and enqueues `email.send`. Worker path — `email.send` acquires a token from a Postgres-backed instance-wide SES bucket, calls `SESv2 SendEmail` (Simple content + Attachments, `EmailTags` carrying the email id), records `sent`. Feedback path — the existing SNS webhook parses SES event JSON, matches by `EmailTags` (fallback: `ses_message_id`), inserts idempotent `email_events`, updates status/suppressions, fans out `webhook.deliver` jobs. Everything stays inside the existing job runtime (`registerQueue`, exclusive policies, sweeps).

**Tech Stack:** existing stack + `smtp-server` 3.19 (+ `@types/smtp-server`), `mailparser` 3.9 (+ types), `selfsigned` (dev cert for STARTTLS), `@aws-sdk/client-sesv2` `SendEmailCommand`, Postgres `LISTEN/NOTIFY` via postgres-js for SSE, Vitest + embedded Postgres + aws-sdk-client-mock, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-24-sendsprite-design.md` §4 (pipeline), §5 (`api_keys`, `emails`, `email_attachments`, `email_events`, `suppressions`, `webhooks`, `webhook_deliveries`), §7 (REST), §8 (webhooks), §12 (errors). Phase 2 plan "Phase 2 status" block lists the openers folded in here.

**Decisions made while planning:**

- **Attachments** use SESv2 `Content.Simple.Attachments` (no hand-built MIME). If the installed SDK lacks that field (check `node_modules/@aws-sdk/client-sesv2/dist-types/models`), fall back to `Content.Raw` built with `nodemailer/lib/mime-node` — Task 8 says how.
- **Event attribution**: every send carries `EmailTags: [{Name:"ss_email", Value:<emailId>}, {Name:"ss_team", Value:<teamId>}]`; SES echoes them in `mail.tags`. Ingestion matches on that first, `ses_message_id` second.
- **Rate limiting**: SES quota is account-wide, so one instance-level token bucket (`send_rate_state` row, `MaxSendRate` tokens/s, refreshed hourly from `instance_settings`) + per-team daily/monthly caps from `team_settings` (counted from `emails`). When the bucket is empty the job re-enqueues itself with a short `startAfter` via the sweep-safe pattern (the send queue uses the default `standard` policy, so a job may re-enqueue itself; dedup is by the `emails.status` guard, not `singletonKey`).
- **Tracking**: opens via `/t/o/:emailId.gif`; clicks via `/t/c/:emailId?u=<url>&s=<hmac>` (HMAC prevents open-redirect abuse). Applied per team defaults (`team_settings.track_opens/track_clicks`) overridable per request. SES's own open/click tracking is **not** used (config set overrides `OpenTrackingEnabled/ClickTrackingEnabled: false`) so counts have one source.
- **Live updates**: minimal SSE `/api/stream` backed by Postgres `NOTIFY sendsprite_team_<teamId>`; the emails list/detail refetch on message. No TanStack Query dependency — a tiny `useTeamStream` hook triggers `router.refresh()`.
- **SMTP relay** listens on 587 with STARTTLS using `SMTP_TLS_CERT/KEY` when set, else a self-signed cert generated at boot (dev/self-host default; documented). Auth: username anything, password = API key. Messages are parsed with `mailparser` and go through the same `createEmail` path with `source: "smtp"`.
- **Webhook failure email to owners** (spec §8) needs a verified sending domain of the _instance_; Phase 3 logs + shows a dashboard banner and marks the webhook disabled; the email notification is a Phase 5 item.
- **Owner emails on suppression thresholds** likewise → banner only in Phase 3.
- **Domain deletion vs mail log** (review of Tasks 1–3): `emails.domain_id` is nullable with `ON DELETE SET NULL` — the mail log must never block deleting a domain (migration `0008`). `send_rate_state` carries an `id = 1` check so the bucket stays a singleton.
- **Header injection** (review of Tasks 1–3): `SendEmailInput` rejects CR/LF in `from`, recipients, `subject`, header values, attachment filenames and content types; header names are `[A-Za-z0-9-]{1,80}`; reserved headers also include `Return-Path`, `Sender`, `DKIM-Signature`, `Received`, `Content-Transfer-Encoding`, `Authentication-Results` (`List-Unsubscribe` stays allowed); tag keys `[A-Za-z0-9_-]{1,64}`, at most 20 tags; attachment `content` must be base64 (whitespace stripped), filenames may not contain `/` or `\`.
- **Complaints** (review of Tasks 1–3): `complaintFeedbackType: "not-spam"` is a retraction and does not suppress.
- REST `/api/v1/domains`, `/api-keys`, `/webhooks`, `/suppressions` ship here (thin wrappers over existing services). Templates/contacts/campaigns REST are Phase 5.

---

## File structure (Phase 3 additions)

```
packages/shared/src/
├─ api/errors.ts              ErrorCode union + ApiError shape
├─ api/emails.ts              zod: SendEmailInput, EmailStatus, Email, EmailEvent
├─ api/webhooks.ts            WebhookEventType union, WebhookPayload<T>, signature helpers (pure)
└─ index.ts                   re-exports
apps/web/
├─ src/db/schema/
│  ├─ api-keys.ts · emails.ts · email-attachments.ts · email-events.ts
│  ├─ suppressions.ts · webhooks.ts · webhook-deliveries.ts · send-rate.ts · worker-heartbeats.ts
│  └─ index.ts
├─ drizzle/0007_*.sql
├─ src/lib/
│  ├─ api-auth.ts             requireApiKey(req) → { team, key } | ApiError response
│  ├─ api-response.ts         ok()/fail() JSON envelopes, rate-limit headers
│  ├─ email-address.ts        parseAddress(), normaliseEmail() (pure)
│  ├─ tracking.ts             pixelUrl(), wrapLinks(html, emailId, secret) (pure)
│  ├─ webhook-signature.ts    sign()/verify() HMAC (pure)
│  ├─ ses-events.ts           parseSesEvent(json) → normalised event (pure)
│  ├─ notify.ts               notifyTeam(teamId) via NOTIFY; listen() for SSE
│  └─ health.ts               + worker heartbeat age
├─ src/services/
│  ├─ api-keys.ts · emails.ts · send-limits.ts · suppressions.ts · webhooks.ts · email-events.ts · stats.ts
├─ src/jobs/
│  ├─ queues.ts               + emailSend, webhookDeliver, retentionPurge, domainRecheck, heartbeat persist
│  ├─ handlers/email-send.ts · webhook-deliver.ts · retention-purge.ts · heartbeat.ts (persist)
│  └─ handlers/domain-verify.ts   + verified re-check sweep (24 h)
├─ src/smtp/server.ts         SMTP relay (start/stop), src/smtp/inbound.ts (parse → createEmail)
├─ src/instrumentation.ts     + SMTP start, heartbeat persist
├─ src/app/api/v1/
│  ├─ emails/route.ts · emails/batch/route.ts · emails/[id]/route.ts · emails/[id]/cancel/route.ts
│  ├─ domains/route.ts · domains/[id]/route.ts · domains/[id]/verify/route.ts
│  ├─ api-keys/route.ts · api-keys/[id]/route.ts
│  ├─ webhooks/route.ts · webhooks/[id]/route.ts · webhooks/[id]/test/route.ts
│  └─ suppressions/route.ts · suppressions/[email]/route.ts
├─ src/app/api/webhooks/ses/route.ts   Notification branch → ingestion
├─ src/app/api/stream/route.ts         SSE
├─ src/app/t/o/[id]/route.ts · t/c/[id]/route.ts
├─ src/app/app/api-keys/* · emails/* · webhooks/* · suppressions/* · page.tsx (overview stats)
└─ tests/unit/{email-address,tracking,webhook-signature,ses-events,send-limits}.test.ts
   tests/integration/{api-keys,emails,email-send,ses-ingest,webhooks,rest-emails,smtp,stream,retention,stats}.test.ts
   tests/e2e/send.spec.ts
infra: Dockerfile EXPOSE 587, docker-compose port 587, README
```

---

### Task 1: Schema for sending (migration 0007)

**Files:**

- Create: `apps/web/src/db/schema/{api-keys,emails,email-attachments,email-events,suppressions,webhooks,webhook-deliveries,send-rate,worker-heartbeats}.ts`
- Modify: `apps/web/src/db/schema/index.ts`, `packages/shared/src/ids.ts` (ensure `key`, `em`, `evt`, `wh`, `whd`, `sup`, `att`)
- Test: `apps/web/tests/integration/db.test.ts`

- [x] **Step 1: Failing test**

Append to `db.test.ts`:

```ts
it("creates the sending tables with the expected constraints", async () => {
  const rows = await pg.db.execute(
    sql`select table_name from information_schema.tables where table_schema='public'`,
  );
  const names = rows.map((r) => r.table_name);
  for (const t of [
    "api_keys",
    "emails",
    "email_attachments",
    "email_events",
    "suppressions",
    "webhooks",
    "webhook_deliveries",
    "send_rate_state",
    "worker_heartbeats",
  ])
    expect(names).toContain(t);
  const idx = await pg.db.execute(
    sql`select indexname from pg_indexes where tablename in ('emails','email_events','suppressions','api_keys')`,
  );
  const idxNames = idx.map((r) => r.indexname);
  expect(idxNames).toEqual(
    expect.arrayContaining([
      "emails_team_idempotency_uidx",
      "emails_ses_message_uidx",
      "email_events_dedupe_uidx",
      "suppressions_team_email_uidx",
      "api_keys_hash_uidx",
    ]),
  );
});
```

Run: `cd apps/web && bun run test:integration -- db` → FAIL.

- [x] **Step 2: Schema files**

`api-keys.ts`:

```ts
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { domains } from "./domains";

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(), // key_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(), // "ss_live_ab12cd34" (first 8 chars after prefix), shown in UI
    keyHash: text("key_hash").notNull(), // sha256 hex of the full key
    permission: text("permission", { enum: ["full", "sending_only"] })
      .notNull()
      .default("full"),
    domainId: text("domain_id").references(() => domains.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_hash_uidx").on(t.keyHash),
    index("api_keys_team_idx").on(t.teamId),
  ],
);
```

`emails.ts`:

```ts
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { domains } from "./domains";

export const EMAIL_STATUSES = [
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
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const emails = pgTable(
  "emails",
  {
    id: text("id").primaryKey(), // em_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    apiKeyId: text("api_key_id"),
    domainId: text("domain_id").references(() => domains.id, {
      onDelete: "set null",
    }), // nullable: the mail log must not block domain deletion (migration 0008)
    from: text("from").notNull(), // "Name <a@b>" as given
    fromEmail: text("from_email").notNull(), // normalised address
    to: jsonb("to").$type<string[]>().notNull(),
    cc: jsonb("cc").$type<string[]>().notNull().default([]),
    bcc: jsonb("bcc").$type<string[]>().notNull().default([]),
    replyTo: jsonb("reply_to").$type<string[]>().notNull().default([]),
    subject: text("subject").notNull(),
    html: text("html"),
    text: text("text"),
    headers: jsonb("headers")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    tags: jsonb("tags").$type<Record<string, string>>().notNull().default({}),
    attachmentsMeta: jsonb("attachments_meta")
      .$type<
        { id: string; filename: string; contentType: string; size: number }[]
      >()
      .notNull()
      .default([]),
    trackOpens: boolean("track_opens").notNull().default(true),
    trackClicks: boolean("track_clicks").notNull().default(true),
    status: text("status", { enum: EMAIL_STATUSES })
      .notNull()
      .default("queued"),
    source: text("source", { enum: ["api", "smtp", "campaign", "dashboard"] })
      .notNull()
      .default("api"),
    idempotencyKey: text("idempotency_key"),
    sesMessageId: text("ses_message_id"),
    lastError: text("last_error"),
    attempts: integer("attempts").notNull().default(0),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    bodyPurgedAt: timestamp("body_purged_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("emails_team_idempotency_uidx").on(t.teamId, t.idempotencyKey),
    uniqueIndex("emails_ses_message_uidx").on(t.sesMessageId),
    index("emails_team_created_idx").on(t.teamId, t.createdAt),
    index("emails_team_status_idx").on(t.teamId, t.status),
    index("emails_purge_idx").on(t.bodyPurgedAt, t.createdAt),
  ],
);
```

(`trackOpens/trackClicks` are `boolean`; Task 7 must stay consistent. `EMAIL_STATUSES` re-exports `EMAIL_STATUS` from `@sendsprite/shared` rather than duplicating the tuple.)

`email-attachments.ts`:

```ts
import {
  customType,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { emails } from "./emails";
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
export const emailAttachments = pgTable("email_attachments", {
  id: text("id").primaryKey(), // att_<ulid>
  emailId: text("email_id")
    .notNull()
    .references(() => emails.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  bytes: bytea("bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

`email-events.ts`:

```ts
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { emails } from "./emails";
export const EMAIL_EVENT_TYPES = [
  "queued",
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "rejected",
  "opened",
  "clicked",
  "failed",
  "cancelled",
] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];
export const emailEvents = pgTable(
  "email_events",
  {
    id: text("id").primaryKey(), // evt_<ulid>
    emailId: text("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    type: text("type", { enum: EMAIL_EVENT_TYPES }).notNull(),
    dedupeKey: text("dedupe_key").notNull(), // e.g. "sns:<MessageId>" or "local:<ulid>"
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("email_events_dedupe_uidx").on(t.emailId, t.dedupeKey),
    index("email_events_email_idx").on(t.emailId, t.occurredAt),
    index("email_events_team_type_idx").on(t.teamId, t.type, t.occurredAt),
  ],
);
```

`suppressions.ts`:

```ts
import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./auth";
export const suppressions = pgTable(
  "suppressions",
  {
    id: text("id").primaryKey(), // sup_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // normalised
    reason: text("reason", {
      enum: ["bounce", "complaint", "manual", "unsubscribe"],
    }).notNull(),
    sourceEmailId: text("source_email_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("suppressions_team_email_uidx").on(t.teamId, t.email)],
);
```

`webhooks.ts`:

```ts
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(), // wh_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secretEnc: text("secret_enc").notNull(),
    events: jsonb("events").$type<string[]>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    disabledReason: text("disabled_reason"),
    failingSince: timestamp("failing_since", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("webhooks_team_idx").on(t.teamId)],
);
```

`webhook-deliveries.ts`:

```ts
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { webhooks } from "./webhooks";
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(), // whd_<ulid>
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    eventId: text("event_id").notNull(), // evt_… id echoed as Sendsprite-Event-Id
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempt: integer("attempt").notNull().default(0),
    status: text("status", {
      enum: ["pending", "delivered", "failed", "exhausted"],
    })
      .notNull()
      .default("pending"),
    statusCode: integer("status_code"),
    responseExcerpt: text("response_excerpt"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_webhook_idx").on(t.webhookId, t.createdAt),
    index("webhook_deliveries_retry_idx").on(t.status, t.nextRetryAt),
  ],
);
```

`send-rate.ts`:

```ts
import {
  doublePrecision,
  integer,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";
/** Singleton token bucket for the SES account-wide MaxSendRate. */
export const sendRateState = pgTable(
  "send_rate_state",
  {
    id: integer("id").primaryKey().default(1),
    tokens: doublePrecision("tokens").notNull().default(0),
    refilledAt: timestamp("refilled_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  () => [check("send_rate_state_singleton", sql`id = 1`)],
);
```

`worker-heartbeats.ts`:

```ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
export const workerHeartbeats = pgTable("worker_heartbeats", {
  processId: text("process_id").primaryKey(), // hostname:pid
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
```

Export all from `schema/index.ts`. Add `"att"` to `ID_PREFIXES` if missing (others exist).

- [x] **Step 3: Migrate, test, commit**

Run: `cd apps/web && bun run db:generate` → `0007_*.sql`; `bun run test:integration -- db` → PASS.

```bash
git add apps/web packages/shared && git commit -m "feat(web): sending schema — api_keys, emails, events, suppressions, webhooks, rate state, heartbeats"
```

---

### Task 2: Shared API contracts (zod) — TDD

**Files:**

- Create: `packages/shared/src/api/errors.ts`, `packages/shared/src/api/emails.ts`, `packages/shared/src/api/webhooks.ts`, `packages/shared/tests/api-emails.test.ts`, `packages/shared/tests/webhook-signature.test.ts`
- Modify: `packages/shared/src/index.ts`

- [x] **Step 1: Failing tests**

`tests/api-emails.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SendEmailInput } from "../src/api/emails";
const base = {
  from: "Acme <hello@mail.acme.com>",
  to: ["a@b.com"],
  subject: "Hi",
  html: "<p>x</p>",
};
describe("SendEmailInput", () => {
  it("accepts a minimal message and normalises recipients to arrays", () => {
    const r = SendEmailInput.parse({ ...base, to: "a@b.com" });
    expect(r.to).toEqual(["a@b.com"]);
    expect(r.cc).toEqual([]);
    expect(r.replyTo).toEqual([]);
  });
  it("requires html, text or template", () => {
    expect(() =>
      SendEmailInput.parse({ from: base.from, to: base.to, subject: "x" }),
    ).toThrow(/html|text|template/);
  });
  it("caps recipients at 50 total and rejects invalid emails", () => {
    expect(() =>
      SendEmailInput.parse({
        ...base,
        to: Array.from({ length: 51 }, (_, i) => `u${i}@b.com`),
      }),
    ).toThrow(/50/);
    expect(() =>
      SendEmailInput.parse({ ...base, to: ["not-an-email"] }),
    ).toThrow();
  });
  it("validates attachments (base64, ≤ 10 MB total) and scheduledAt (future ISO)", () => {
    expect(
      SendEmailInput.parse({
        ...base,
        attachments: [
          { filename: "a.txt", content: Buffer.from("hi").toString("base64") },
        ],
      }).attachments,
    ).toHaveLength(1);
    expect(() =>
      SendEmailInput.parse({ ...base, scheduledAt: "not-a-date" }),
    ).toThrow();
  });
  it("rejects reserved headers", () => {
    expect(() =>
      SendEmailInput.parse({ ...base, headers: { To: "x" } }),
    ).toThrow(/reserved/i);
  });
});
```

`tests/webhook-signature.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhookSignature } from "../src/api/webhooks";
describe("webhook signature", () => {
  it("round-trips and rejects tampering / stale timestamps", () => {
    const body = JSON.stringify({ id: "evt_1", type: "email.delivered" });
    const header = signWebhook(body, "whsec_test", 1_700_000_000);
    expect(header).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
    expect(
      verifyWebhookSignature(body, header, "whsec_test", {
        now: 1_700_000_100,
      }),
    ).toBe(true);
    expect(
      verifyWebhookSignature(body + " ", header, "whsec_test", {
        now: 1_700_000_100,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature(body, header, "whsec_test", {
        now: 1_700_000_000 + 600,
      }),
    ).toBe(false); // > 300 s
  });
});
```

Run: `cd packages/shared && bun run test` → FAIL.

- [x] **Step 2: Implement**

`src/api/errors.ts`:

```ts
export const ERROR_CODES = [
  "validation_error",
  "unauthorized",
  "forbidden",
  "not_found",
  "domain_not_verified",
  "suppressed_recipient",
  "rate_limited",
  "daily_quota_exceeded",
  "monthly_quota_exceeded",
  "sandbox_restricted",
  "idempotency_conflict",
  "payload_too_large",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}
export const HTTP_STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  domain_not_verified: 422,
  suppressed_recipient: 422,
  rate_limited: 429,
  daily_quota_exceeded: 429,
  monthly_quota_exceeded: 429,
  sandbox_restricted: 422,
  idempotency_conflict: 409,
  payload_too_large: 413,
  internal_error: 500,
};
```

`src/api/emails.ts`:

```ts
import { z } from "zod";
const email = z
  .string()
  .trim()
  .email()
  .transform((s) => s.toLowerCase());
// "Name <a@b>" or "a@b" (shape-checked, no CR/LF); display names parsed server-side.
const addr = z.string().trim().min(3).max(320).regex(NO_CRLF).regex(ADDR_RE);
const list = z
  .union([addr, z.array(addr)])
  .default([])
  .transform((v) => (Array.isArray(v) ? v : [v]));
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
]); // `list-unsubscribe` is allowed
export const AttachmentInput = z.object({
  filename: z.string().min(1).max(255), // no CR/LF, no `/` or `\`
  content: z.string().min(1), // base64 (whitespace stripped, validated)
  contentType: z.string().max(255).optional(),
});
export const SendEmailInput = z
  .object({
    from: addr,
    to: z
      .union([addr, z.array(addr).min(1)])
      .transform((v) => (Array.isArray(v) ? v : [v])),
    cc: list,
    bcc: list,
    replyTo: list,
    subject: z.string().min(1).max(998),
    html: z.string().max(5_000_000).optional(),
    text: z.string().max(5_000_000).optional(),
    template: z.string().min(1).max(64).optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
    headers: z
      .record(z.string(), z.string().max(1000))
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
          10 * 1024 * 1024,
        { message: "attachments exceed 10 MB" },
      ),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    tags: z.record(z.string().max(64), z.string().max(256)).default({}), // keys [A-Za-z0-9_-], at most 20
    idempotencyKey: z.string().min(1).max(256).optional(),
    trackOpens: z.boolean().optional(),
    trackClicks: z.boolean().optional(),
    overrideSuppression: z.boolean().optional(),
  })
  .refine((v) => v.html || v.text || v.template, {
    message: "one of html, text or template is required",
  })
  .refine((v) => v.to.length + v.cc.length + v.bcc.length <= 50, {
    message: "at most 50 recipients",
  });
export type SendEmailInput = z.infer<typeof SendEmailInput>;
export const BatchSendInput = z.array(SendEmailInput).min(1).max(100);
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
export const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
  status: z.enum(EMAIL_STATUS).optional(),
  to: z.string().optional(),
  domainId: z.string().optional(),
  tag: z.string().optional(),
});
```

(Note `email` const is unused unless you use it for `to` when no display name is allowed; keep `addr` and parse display names server-side.)

`src/api/webhooks.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
export const WEBHOOK_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delayed",
  "email.bounced",
  "email.complained",
  "email.opened",
  "email.clicked",
  "email.failed",
  "contact.created",
  "contact.updated",
  "contact.unsubscribed",
  "contact.resubscribed",
  "domain.verified",
  "domain.failed",
  "campaign.sent",
  "campaign.completed",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
export interface WebhookPayload<T = Record<string, unknown>> {
  id: string;
  type: WebhookEventType;
  createdAt: string;
  data: T;
}
export const SIGNATURE_HEADER = "sendsprite-signature";
export const EVENT_ID_HEADER = "sendsprite-event-id";
export function signWebhook(
  body: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const v1 = createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${v1}`;
}
export function verifyWebhookSignature(
  body: string,
  header: string,
  secret: string,
  opts: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  const m = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header ?? "");
  if (!m) return false;
  const t = Number(m[1]);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = createHmac("sha256", secret)
    .update(`${t}.${body}`)
    .digest("hex");
  const a = Buffer.from(m[2]!, "hex"),
    b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

`node:crypto` in the shared package: it is used by the Node SDK (`sendsprite/next`) and the server; browser bundles must not import `api/webhooks` (document in the file header). Export all three modules from `index.ts`.

- [x] **Step 3: Run, commit**

Run: `cd packages/shared && bun run test && bun run typecheck` → PASS. Commit `feat(shared): API contracts — send input, error codes, webhook types + signature`.

---

### Task 3: Pure helpers — address parsing, tracking rewrite, SES event parsing (TDD)

**Files:**

- Create: `apps/web/src/lib/email-address.ts`, `apps/web/src/lib/tracking.ts`, `apps/web/src/lib/ses-events.ts`
- Test: `apps/web/tests/unit/{email-address,tracking,ses-events}.test.ts`

- [x] **Step 1: Failing tests**

`email-address.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseAddress, normaliseEmail, domainOf } from "@/lib/email-address";
describe("parseAddress", () => {
  it("parses name-addr and addr-spec", () => {
    expect(parseAddress("Acme Team <Hello@Mail.Acme.com>")).toEqual({
      name: "Acme Team",
      email: "hello@mail.acme.com",
      raw: "Acme Team <Hello@Mail.Acme.com>",
    });
    expect(parseAddress("a@b.com")).toEqual({
      name: null,
      email: "a@b.com",
      raw: "a@b.com",
    });
    expect(parseAddress('"Smith, J" <j@x.io>')?.name).toBe("Smith, J");
  });
  it("returns null for junk", () => {
    expect(parseAddress("nope")).toBeNull();
    expect(parseAddress("<>")).toBeNull();
  });
  it("domainOf and normaliseEmail", () => {
    expect(domainOf("x@Mail.Acme.com")).toBe("mail.acme.com");
    expect(normaliseEmail(" A@B.COM ")).toBe("a@b.com");
  });
});
```

`tracking.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { wrapLinks, pixelTag, signClick, verifyClick } from "@/lib/tracking";
const base = "https://mail.acme.com";
const secret = "s".repeat(32);
describe("tracking", () => {
  it("rewrites http(s) hrefs to signed click urls and leaves mailto/anchors", () => {
    const html =
      '<a href="https://x.io/a?b=1">x</a> <a href="mailto:a@b">m</a> <a href="#top">t</a>';
    const out = wrapLinks(html, "em_1", base, secret);
    expect(out).toContain(
      `${base}/t/c/em_1?u=${encodeURIComponent("https://x.io/a?b=1")}&s=`,
    );
    expect(out).toContain('href="mailto:a@b"');
    expect(out).toContain('href="#top"');
  });
  it("signs and verifies click targets", () => {
    const s = signClick("em_1", "https://x.io", secret);
    expect(verifyClick("em_1", "https://x.io", s, secret)).toBe(true);
    expect(verifyClick("em_1", "https://evil.io", s, secret)).toBe(false);
  });
  it("pixelTag points at /t/o/<id>.gif", () => {
    expect(pixelTag("em_1", base)).toContain(`${base}/t/o/em_1.gif`);
  });
});
```

`ses-events.test.ts` (fixtures from the SES docs):

```ts
import { describe, expect, it } from "vitest";
import { parseSesEvent } from "@/lib/ses-events";
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
      }).suppress,
    ).toEqual([]);
  });
  it("maps Complaint, Send, Reject, DeliveryDelay, Open, Click, Rendering Failure", () => {
    expect(
      parseSesEvent({
        eventType: "Complaint",
        mail,
        complaint: {
          complainedRecipients: [{ emailAddress: "r@x.io" }],
          timestamp: mail.timestamp,
          feedbackId: "c1",
          complaintFeedbackType: "abuse",
        },
      }),
    ).toMatchObject({
      type: "complained",
      suppress: [{ email: "r@x.io", reason: "complaint" }],
    });
    expect(parseSesEvent({ eventType: "Send", mail, send: {} }).type).toBe(
      "sent",
    );
    expect(
      parseSesEvent({
        eventType: "Reject",
        mail,
        reject: { reason: "Bad content" },
      }),
    ).toMatchObject({ type: "rejected" });
    expect(
      parseSesEvent({
        eventType: "DeliveryDelay",
        mail,
        deliveryDelay: {
          delayType: "MailboxFull",
          timestamp: mail.timestamp,
          delayedRecipients: [{ emailAddress: "r@x.io" }],
        },
      }).type,
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
      }).type,
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
      }).type,
    ).toBe("clicked");
    expect(
      parseSesEvent({
        eventType: "Rendering Failure",
        mail,
        failure: { templateName: "t", errorMessage: "e" },
      }).type,
    ).toBe("failed");
  });
  it("falls back to messageId when tags are missing and returns null for unknown types", () => {
    expect(
      parseSesEvent({
        eventType: "Delivery",
        mail: { ...mail, tags: {} },
        delivery: { timestamp: mail.timestamp, recipients: [] },
      }),
    ).toMatchObject({ emailId: null, sesMessageId: "ses-msg-1" });
    expect(
      parseSesEvent({ eventType: "Subscription", mail, subscription: {} }),
    ).toBeNull();
    expect(parseSesEvent({ nope: 1 })).toBeNull();
  });
});
```

Run: `cd apps/web && bun run test` → FAIL.

- [x] **Step 2: Implement**

`lib/email-address.ts`:

```ts
export interface ParsedAddress {
  name: string | null;
  email: string;
  raw: string;
}
const ADDR = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export const normaliseEmail = (s: string) => s.trim().toLowerCase();
export const domainOf = (email: string) =>
  normaliseEmail(email).split("@")[1] ?? "";
/** RFC 5322-lite: `Name <a@b>`, `"Quoted, Name" <a@b>`, or `a@b`. */
export function parseAddress(raw: string): ParsedAddress | null {
  const s = raw.trim();
  const m = /^(?:"((?:[^"\\]|\\.)*)"|([^<]*?))\s*<([^<>]+)>$/.exec(s);
  if (m) {
    const email = normaliseEmail(m[3]!);
    if (!ADDR.test(email)) return null;
    const name = (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1").trim();
    return { name: name || null, email, raw: s };
  }
  const email = normaliseEmail(s);
  return ADDR.test(email) ? { name: null, email, raw: s } : null;
}
export const formatAddress = (a: ParsedAddress) =>
  a.name ? `"${a.name.replace(/[\\"]/g, "\\$&")}" <${a.email}>` : a.email;
```

`lib/tracking.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
export const signClick = (emailId: string, url: string, secret: string) =>
  createHmac("sha256", secret)
    .update(`${emailId}\n${url}`)
    .digest("base64url")
    .slice(0, 32);
export function verifyClick(
  emailId: string,
  url: string,
  sig: string,
  secret: string,
) {
  const a = Buffer.from(signClick(emailId, url, secret));
  const b = Buffer.from(sig ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}
export const pixelTag = (emailId: string, base: string) =>
  `<img src="${base}/t/o/${emailId}.gif" width="1" height="1" alt="" style="display:none;max-width:1px;max-height:1px" />`;
/** Rewrites `href="http(s)://…"` inside anchor tags; leaves mailto:, tel:, #anchors, and data- attrs alone. */
export function wrapLinks(
  html: string,
  emailId: string,
  base: string,
  secret: string,
): string {
  return html.replace(
    /(<a\b[^>]*?[\s"']href=)(["'])(https?:\/\/[^"']+)\2/gi, // not data-href
    (_m, pre, q, url) => {
      if (url.startsWith(`${base}/t/`)) return `${pre}${q}${url}${q}`;
      const u = url.replace(/&amp;/g, "&");
      return `${pre}${q}${base}/t/c/${emailId}?u=${encodeURIComponent(u)}&s=${signClick(emailId, u, secret)}${q}`;
    },
  );
}
export function injectPixel(html: string, emailId: string, base: string) {
  const tag = pixelTag(emailId, base);
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${tag}</body>`)
    : html + tag;
}
```

`lib/ses-events.ts`:

```ts
import type { EmailEventType } from "@/db/schema/email-events";
export interface NormalisedSesEvent {
  type: EmailEventType;
  emailId: string | null;
  teamId: string | null;
  sesMessageId: string;
  recipients: string[];
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
const first = (v: unknown) =>
  Array.isArray(v)
    ? ((v[0] as string | undefined) ?? null)
    : typeof v === "string"
      ? v
      : null;
const lower = (s: string) => s.trim().toLowerCase();
export function parseSesEvent(raw: unknown): NormalisedSesEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const eventType = r.eventType ?? r.notificationType;
  const type = TYPE_MAP[eventType];
  const mail = r.mail;
  if (!type || !mail?.messageId) return null;
  const tags = mail.tags ?? {};
  const b = r.bounce,
    c = r.complaint,
    d = r.delivery,
    dd = r.deliveryDelay;
  const recipients: string[] = (
    b?.bouncedRecipients?.map((x: any) => x.emailAddress) ??
    c?.complainedRecipients?.map((x: any) => x.emailAddress) ??
    d?.recipients ??
    dd?.delayedRecipients?.map((x: any) => x.emailAddress) ??
    mail.destination ??
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
      : type === "complained" && c?.complaintFeedbackType !== "not-spam"
        ? recipients.map((email) => ({ email, reason: "complaint" as const }))
        : [];
  const detail = b
    ? {
        bounceType: b.bounceType,
        bounceSubType: b.bounceSubType,
        diagnosticCode: b.bouncedRecipients?.[0]?.diagnosticCode ?? null,
        feedbackId: b.feedbackId,
      }
    : c
      ? {
          complaintFeedbackType: c.complaintFeedbackType ?? null,
          feedbackId: c.feedbackId,
          complaintSubType: c.complaintSubType ?? null,
        }
      : d
        ? {
            smtpResponse: d.smtpResponse,
            processingTimeMillis: d.processingTimeMillis,
            reportingMTA: d.reportingMTA,
          }
        : dd
          ? { delayType: dd.delayType, expirationTime: dd.expirationTime }
          : r.reject
            ? { reason: r.reject.reason }
            : r.open
              ? {
                  ipAddress: r.open.ipAddress,
                  userAgent: r.open.userAgent,
                  isBotEvent: r.open.isBotEvent,
                }
              : r.click
                ? {
                    link: r.click.link,
                    ipAddress: r.click.ipAddress,
                    userAgent: r.click.userAgent,
                    linkTags: r.click.linkTags,
                  }
                : r.failure
                  ? {
                      templateName: r.failure.templateName,
                      errorMessage: r.failure.errorMessage,
                    }
                  : {};
  return {
    type,
    emailId: first(tags.ss_email),
    teamId: first(tags.ss_team),
    sesMessageId: String(mail.messageId),
    recipients,
    occurredAt: new Date(ts ?? Date.now()),
    payload: { eventType, ...detail },
    suppress,
  };
}
```

- [x] **Step 3: Run, commit**

Run: `cd apps/web && bun run test` → PASS. Commit `feat(web): address parsing, tracking rewrite, SES event normalisation`.

---

### Task 4: API keys — service, auth guard, REST + UI

**Files:**

- Create: `apps/web/src/services/api-keys.ts`, `apps/web/src/lib/api-auth.ts`, `apps/web/src/lib/api-response.ts`, `apps/web/src/app/api/v1/api-keys/route.ts`, `apps/web/src/app/api/v1/api-keys/[id]/route.ts`, `apps/web/src/app/app/api-keys/{page.tsx,actions.ts,ApiKeysPanel.tsx}`
- Test: `apps/web/tests/integration/api-keys.test.ts`

- [x] **Step 1: Failing test**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { startPg } from "./_pg";
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
describe("api keys", () => {
  it("creates a key shown once, stores only its hash, authenticates requests, tracks last use", async () => {
    const { createApiKey, listApiKeys } = await import("@/services/api-keys");
    const res = await createApiKey(actor, { name: "prod", permission: "full" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.secret).toMatch(/^ss_live_[A-Za-z0-9_-]{40,}$/);
    const { apiKeys } = await import("@/db/schema");
    const [row] = await pg.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, res.data.id));
    expect(row!.keyHash).not.toContain(res.data.secret);
    expect(row!.keyPrefix).toBe(res.data.secret.slice(0, 16));
    const { authenticateApiKey } = await import("@/lib/api-auth");
    const auth = await authenticateApiKey(`Bearer ${res.data.secret}`);
    expect(auth).toMatchObject({
      ok: true,
      team: { id: "org_1" },
      key: { id: res.data.id, permission: "full" },
    });
    expect((await listApiKeys("org_1"))[0]!.lastUsedAt).toBeTruthy();
    expect(await authenticateApiKey("Bearer ss_live_nope")).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
    expect(await authenticateApiKey("")).toMatchObject({
      ok: false,
      code: "unauthorized",
    });
  });
  it("revoked keys stop working; members cannot create keys", async () => {
    const { createApiKey, revokeApiKey } = await import("@/services/api-keys");
    const res = await createApiKey(actor, { name: "tmp" });
    if (!res.ok) throw new Error(res.error);
    expect((await revokeApiKey(actor, res.data.id)).ok).toBe(true);
    const { authenticateApiKey } = await import("@/lib/api-auth");
    expect(await authenticateApiKey(`Bearer ${res.data.secret}`)).toMatchObject(
      { ok: false },
    );
    expect(
      (await createApiKey({ ...actor, role: "member" }, { name: "x" })).ok,
    ).toBe(false);
  });
});
```

Run → FAIL.

- [x] **Step 2: Service**

`services/api-keys.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, desc } from "drizzle-orm";
import { z } from "zod";
import { can, newId } from "@sendsprite/shared";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import type { Result } from "@/lib/result";
import type { TeamActor } from "./team";
export const hashKey = (k: string) =>
  createHash("sha256").update(k).digest("hex");
const DENIED: Result<never> = {
  ok: false,
  error: "You don't have permission to do that.",
};
const input = z.object({
  name: z.string().trim().min(1).max(64),
  permission: z.enum(["full", "sending_only"]).default("full"),
  domainId: z.string().optional(),
});
export async function listApiKeys(teamId: string) {
  return db()
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.teamId, teamId))
    .orderBy(desc(apiKeys.createdAt));
}
export async function createApiKey(
  actor: TeamActor,
  raw: unknown,
): Promise<Result<{ id: string; secret: string }>> {
  if (!can(actor.role, "apiKeys.create")) return DENIED;
  const p = input.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const secret = `ss_live_${randomBytes(32).toString("base64url")}`;
  const id = newId("key");
  await db()
    .insert(apiKeys)
    .values({
      id,
      teamId: actor.teamId,
      name: p.data.name,
      permission: p.data.permission,
      domainId: p.data.domainId ?? null,
      keyPrefix: secret.slice(0, 16),
      keyHash: hashKey(secret),
      createdBy: actor.userId,
    });
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "apiKeys.create",
    targetType: "apiKey",
    targetId: id,
    diff: { name: { to: p.data.name }, permission: { to: p.data.permission } },
    ...actor.meta,
  });
  return { ok: true, data: { id, secret } };
}
export async function revokeApiKey(
  actor: TeamActor,
  id: string,
): Promise<Result> {
  if (!can(actor.role, "apiKeys.revoke")) return DENIED;
  const [row] = await db()
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, id),
        eq(apiKeys.teamId, actor.teamId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning();
  if (!row) return { ok: false, error: "API key not found." };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "apiKeys.revoke",
    targetType: "apiKey",
    targetId: id,
    ...actor.meta,
  });
  return { ok: true, data: undefined };
}
```

`lib/api-auth.ts`:

```ts
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys, organization } from "@/db/schema";
import { hashKey } from "@/services/api-keys";
import type { ErrorCode } from "@sendsprite/shared";
export type ApiAuth =
  | {
      ok: true;
      team: { id: string; name: string };
      key: {
        id: string;
        permission: "full" | "sending_only";
        domainId: string | null;
      };
    }
  | { ok: false; code: ErrorCode; message: string };
/** Bearer ss_live_… → team + key. Updates last_used_at at most once per minute. */
export async function authenticateApiKey(
  authorization: string | null,
): Promise<ApiAuth> {
  const m = /^Bearer\s+(ss_live_[A-Za-z0-9_-]{20,})$/.exec(authorization ?? "");
  if (!m)
    return {
      ok: false,
      code: "unauthorized",
      message: "Missing or malformed API key.",
    };
  const [row] = await db()
    .select({
      key: apiKeys,
      team: { id: organization.id, name: organization.name },
    })
    .from(apiKeys)
    .innerJoin(organization, eq(apiKeys.teamId, organization.id))
    .where(and(eq(apiKeys.keyHash, hashKey(m[1]!)), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row)
    return { ok: false, code: "unauthorized", message: "Invalid API key." };
  const stale =
    !row.key.lastUsedAt || Date.now() - row.key.lastUsedAt.getTime() > 60_000;
  if (stale)
    await db()
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, row.key.id));
  return {
    ok: true,
    team: row.team,
    key: {
      id: row.key.id,
      permission: row.key.permission,
      domainId: row.key.domainId,
    },
  };
}
export function requireFullPermission(
  a: Extract<ApiAuth, { ok: true }>,
): ApiAuth {
  return a.key.permission === "full"
    ? a
    : { ok: false, code: "forbidden", message: "This key is sending-only." };
}
```

`lib/api-response.ts`:

```ts
import { NextResponse } from "next/server";
import { HTTP_STATUS, type ErrorCode } from "@sendsprite/shared";
export const fail = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  headers?: HeadersInit,
) =>
  NextResponse.json(
    { error: { code, message, ...(details !== undefined && { details }) } },
    { status: HTTP_STATUS[code], headers },
  );
export const ok = (
  data: unknown,
  init: { status?: number; headers?: HeadersInit } = {},
) =>
  NextResponse.json(data, {
    status: init.status ?? 200,
    headers: init.headers,
  });
/** Wraps a handler: authenticates, catches thrown errors into `internal_error`. */
export function withApiKey(
  handler: (
    req: Request,
    auth: import("./api-auth").ApiAuth & { ok: true },
    ctx: { params: Promise<Record<string, string>> },
  ) => Promise<Response>,
) {
  return async (
    req: Request,
    ctx: { params: Promise<Record<string, string>> },
  ) => {
    const { authenticateApiKey } = await import("./api-auth");
    const auth = await authenticateApiKey(req.headers.get("authorization"));
    if (!auth.ok) return fail(auth.code, auth.message);
    try {
      return await handler(req, auth, ctx);
    } catch (e) {
      console.error("[api]", e);
      return fail("internal_error", "Something went wrong.");
    }
  };
}
```

- [x] **Step 3: REST + UI**

`api/v1/api-keys/route.ts`: `GET` (full keys only) → `{ data: [{ id, name, permission, keyPrefix, lastUsedAt, createdAt }] }`; `POST` → `createApiKey` with a synthetic `TeamActor { userId: "api:"+key.id, teamId, teamName, role: "admin" }` → 201 `{ id, secret }`. `[id]/route.ts`: `DELETE` → revoke. Both use `withApiKey` + `requireFullPermission`.

UI `/app/api-keys`: list (name, prefix `ss_live_ab12…`, permission Badge, last used, created, Revoke w/ confirm), "Create key" form (name, permission select, optional domain select) → shows the secret **once** in a `CopyField` with "Copy it now — we won't show it again". Actions gated by `can(role, "apiKeys.create"|"apiKeys.revoke")`. Add nav item already exists in `AppShell`.

- [x] **Step 4: Run, commit**

`bun run test:integration -- api-keys` → PASS; typecheck. Commit `feat(web): API keys — service, bearer auth, REST, dashboard`.

---

### Task 5: Suppressions service + UI

**Files:**

- Create: `apps/web/src/services/suppressions.ts`, `apps/web/src/app/app/suppressions/{page.tsx,actions.ts,SuppressionsPanel.tsx}`, `apps/web/src/app/api/v1/suppressions/route.ts`, `apps/web/src/app/api/v1/suppressions/[email]/route.ts`
- Test: `apps/web/tests/integration/suppressions.test.ts`

- [x] **Step 1: Failing test**

```ts
describe("suppressions", () => {
  it("adds (idempotent), checks, lists, removes", async () => {
    const {
      addSuppression,
      isSuppressed,
      listSuppressions,
      removeSuppression,
      suppressFromEvent,
    } = await import("@/services/suppressions");
    expect(
      (
        await addSuppression(actor, {
          email: "Bad@X.io",
          reason: "manual",
          note: "asked",
        })
      ).ok,
    ).toBe(true);
    expect(
      (await addSuppression(actor, { email: "bad@x.io", reason: "manual" })).ok,
    ).toBe(true); // idempotent
    expect(await isSuppressed("org_1", ["ok@x.io", "BAD@x.io"])).toEqual([
      { email: "bad@x.io", reason: "manual" },
    ]);
    await suppressFromEvent(
      "org_1",
      [{ email: "b2@x.io", reason: "bounce" }],
      "em_1",
    );
    expect(
      (await listSuppressions("org_1")).map((s) => s.email).sort(),
    ).toEqual(["b2@x.io", "bad@x.io"]);
    expect((await removeSuppression(actor, "bad@x.io")).ok).toBe(true);
    expect(
      (await removeSuppression({ ...actor, role: "member" }, "b2@x.io")).ok,
    ).toBe(false);
  });
});
```

(Same fixture boilerplate as Task 4.) Run → FAIL.

- [x] **Step 2: Service**

```ts
import { and, eq, inArray, desc } from "drizzle-orm";
import { z } from "zod";
import { can, newId } from "@sendsprite/shared";
import { db } from "@/db";
import { suppressions } from "@/db/schema";
import { normaliseEmail } from "@/lib/email-address";
import { recordAudit } from "@/lib/audit";
import type { Result } from "@/lib/result";
import type { TeamActor } from "./team";
export type SuppressionReason =
  "bounce" | "complaint" | "manual" | "unsubscribe";
export const listSuppressions = (teamId: string) =>
  db()
    .select()
    .from(suppressions)
    .where(eq(suppressions.teamId, teamId))
    .orderBy(desc(suppressions.createdAt));
export async function isSuppressed(teamId: string, emails: string[]) {
  const norm = [...new Set(emails.map(normaliseEmail))];
  if (!norm.length) return [];
  const rows = await db()
    .select({ email: suppressions.email, reason: suppressions.reason })
    .from(suppressions)
    .where(
      and(eq(suppressions.teamId, teamId), inArray(suppressions.email, norm)),
    );
  return rows;
}
/** System path (SNS ingestion): no permission check. Idempotent. */
export async function suppressFromEvent(
  teamId: string,
  items: { email: string; reason: SuppressionReason }[],
  sourceEmailId: string | null,
) {
  if (!items.length) return;
  await db()
    .insert(suppressions)
    .values(
      items.map((i) => ({
        id: newId("sup"),
        teamId,
        email: normaliseEmail(i.email),
        reason: i.reason,
        sourceEmailId,
      })),
    )
    .onConflictDoNothing({ target: [suppressions.teamId, suppressions.email] });
}
const input = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((s) => s.toLowerCase()),
  reason: z
    .enum(["manual", "unsubscribe", "bounce", "complaint"])
    .default("manual"),
  note: z.string().max(500).optional(),
});
export async function addSuppression(
  actor: TeamActor,
  raw: unknown,
): Promise<Result> {
  if (!can(actor.role, "contacts.manage"))
    return { ok: false, error: "You don't have permission to do that." };
  const p = input.safeParse(raw);
  if (!p.success) return { ok: false, error: "Enter a valid email." };
  await db()
    .insert(suppressions)
    .values({
      id: newId("sup"),
      teamId: actor.teamId,
      email: p.data.email,
      reason: p.data.reason,
      note: p.data.note ?? null,
    })
    .onConflictDoNothing({ target: [suppressions.teamId, suppressions.email] });
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "suppressions.add",
    targetType: "suppression",
    targetId: p.data.email,
    diff: { reason: { to: p.data.reason } },
    ...actor.meta,
  });
  return { ok: true, data: undefined };
}
export async function removeSuppression(
  actor: TeamActor,
  email: string,
): Promise<Result> {
  if (!can(actor.role, "contacts.manage"))
    return { ok: false, error: "You don't have permission to do that." };
  const [row] = await db()
    .delete(suppressions)
    .where(
      and(
        eq(suppressions.teamId, actor.teamId),
        eq(suppressions.email, normaliseEmail(email)),
      ),
    )
    .returning();
  if (!row) return { ok: false, error: "Not on the suppression list." };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "suppressions.remove",
    targetType: "suppression",
    targetId: row.email,
    ...actor.meta,
  });
  return { ok: true, data: undefined };
}
```

REST: `GET /api/v1/suppressions` (list), `POST` (add manual/unsubscribe), `DELETE /api/v1/suppressions/[email]`. UI `/app/suppressions`: table (email, reason Badge, source email link, created, Remove), add form. `AppShell` NAV: add "Suppressions" after Webhooks.

- [x] **Step 3: Run, commit** → `feat(web): suppressions — service, REST, dashboard`.

---

### Task 6: Send limits — SES token bucket + team caps (TDD)

**Files:**

- Create: `apps/web/src/services/send-limits.ts`
- Test: `apps/web/tests/integration/send-limits.test.ts`

- [x] **Step 1: Failing test**

```ts
describe("send limits", () => {
  it("takeSesToken refills at MaxSendRate and refuses when empty", async () => {
    const { updateInstanceSettings } =
      await import("@/services/instance-settings");
    await updateInstanceSettings(
      { sesMaxSendRate: 2, sesDailyQuota: 200 },
      undefined,
      { audit: false },
    );
    const { takeSesToken, resetRateForTests } =
      await import("@/services/send-limits");
    await resetRateForTests(new Date("2026-08-25T00:00:00Z"));
    const at = (s: number) => new Date(Date.UTC(2026, 7, 25, 0, 0, s));
    expect(await takeSesToken(at(1))).toEqual({ ok: true }); // 2 tokens accrued, burst cap 2
    expect(await takeSesToken(at(1))).toEqual({ ok: true });
    expect(await takeSesToken(at(1))).toMatchObject({
      ok: false,
      retryInMs: expect.any(Number),
    });
    expect(await takeSesToken(at(2))).toEqual({ ok: true }); // refilled
  });
  it("team caps count today's/this month's non-failed emails", async () => {
    const { db } = await import("@/db");
    const { emails, teamSettings } = await import("@/db/schema");
    await db()
      .insert(teamSettings)
      .values({ teamId: "org_1", dailyLimit: 2, monthlyLimit: 100 })
      .onConflictDoUpdate({
        target: teamSettings.teamId,
        set: { dailyLimit: 2 },
      });
    const { checkTeamCaps } = await import("@/services/send-limits");
    expect(await checkTeamCaps("org_1", 2)).toEqual({ ok: true });
    await db()
      .insert(emails)
      .values(
        [1, 2].map((i) => ({
          id: `em_cap${i}`,
          teamId: "org_1",
          domainId: "dom_1",
          from: "a@mail.acme.com",
          fromEmail: "a@mail.acme.com",
          to: ["r@x.io"],
          subject: "s",
          status: "sent",
        })),
      );
    expect(await checkTeamCaps("org_1", 1)).toMatchObject({
      ok: false,
      code: "daily_quota_exceeded",
    });
  });
  it("sandbox refuses unverified recipients only via SES; sesDailyQuota is enforced instance-wide", async () => {
    const { checkInstanceQuota } = await import("@/services/send-limits");
    expect(await checkInstanceQuota(1)).toEqual({ ok: true });
  });
});
```

(Fixture: create `dom_1` domain row for `org_1` in `beforeAll`.) Run → FAIL.

- [x] **Step 2: Implement**

```ts
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { emails, sendRateState, teamSettings } from "@/db/schema";
import { getInstanceSettings } from "./instance-settings";
import type { ErrorCode } from "@sendsprite/shared";
const ACTIVE = [
  "queued",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
] as const;
/** One token = one SES SendEmail. Refills at MaxSendRate/s, burst = MaxSendRate (min 1). Serialised with SELECT … FOR UPDATE. */
export async function takeSesToken(
  now = new Date(),
): Promise<{ ok: true } | { ok: false; retryInMs: number }> {
  const s = await getInstanceSettings();
  const rate = Math.max(1, s.sesMaxSendRate ?? 1);
  return db().transaction(async (tx) => {
    await tx
      .insert(sendRateState)
      .values({ id: 1, tokens: rate, refilledAt: now })
      .onConflictDoNothing();
    const [row] = await tx
      .select()
      .from(sendRateState)
      .where(eq(sendRateState.id, 1))
      .for("update");
    const elapsed = Math.max(
      0,
      (now.getTime() - row!.refilledAt.getTime()) / 1000,
    );
    const tokens = Math.min(rate, row!.tokens + elapsed * rate);
    if (tokens < 1) {
      await tx
        .update(sendRateState)
        .set({ tokens, refilledAt: now })
        .where(eq(sendRateState.id, 1));
      return {
        ok: false as const,
        retryInMs: Math.ceil(((1 - tokens) / rate) * 1000),
      };
    }
    await tx
      .update(sendRateState)
      .set({ tokens: tokens - 1, refilledAt: now })
      .where(eq(sendRateState.id, 1));
    return { ok: true as const };
  });
}
export async function resetRateForTests(now: Date) {
  await db()
    .insert(sendRateState)
    .values({ id: 1, tokens: 0, refilledAt: now })
    .onConflictDoUpdate({
      target: sendRateState.id,
      set: { tokens: 0, refilledAt: now },
    });
}
const startOfDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfMonth = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
export async function checkTeamCaps(
  teamId: string,
  adding: number,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string }> {
  const [ts] = await db()
    .select()
    .from(teamSettings)
    .where(eq(teamSettings.teamId, teamId));
  if (!ts || (ts.dailyLimit == null && ts.monthlyLimit == null))
    return { ok: true };
  const countSince = async (since: Date) =>
    Number(
      (
        await db()
          .select({ n: count() })
          .from(emails)
          .where(
            and(
              eq(emails.teamId, teamId),
              gte(emails.createdAt, since),
              inArray(emails.status, [...ACTIVE]),
            ),
          )
      )[0]!.n,
    );
  if (
    ts.dailyLimit != null &&
    (await countSince(startOfDay(now))) + adding > ts.dailyLimit
  )
    return {
      ok: false,
      code: "daily_quota_exceeded",
      message: `Daily limit of ${ts.dailyLimit} emails reached.`,
    };
  if (
    ts.monthlyLimit != null &&
    (await countSince(startOfMonth(now))) + adding > ts.monthlyLimit
  )
    return {
      ok: false,
      code: "monthly_quota_exceeded",
      message: `Monthly limit of ${ts.monthlyLimit} emails reached.`,
    };
  return { ok: true };
}
/** SES Max24HourSend across the whole instance (SES counts sends, so count `sent`+ statuses in the last 24 h). */
export async function checkInstanceQuota(
  adding: number,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string }> {
  const s = await getInstanceSettings();
  if (!s.sesDailyQuota) return { ok: true };
  const since = new Date(now.getTime() - 24 * 3600 * 1000);
  const n = Number(
    (
      await db()
        .select({ n: count() })
        .from(emails)
        .where(
          and(gte(emails.sentAt, since), sql`${emails.sentAt} is not null`),
        )
    )[0]!.n,
  );
  return n + adding > s.sesDailyQuota
    ? {
        ok: false,
        code: "daily_quota_exceeded",
        message: `SES 24-hour quota of ${s.sesDailyQuota} reached.`,
      }
    : { ok: true };
}
```

- [x] **Step 3: Run, commit** → `feat(web): send limits — SES token bucket, team caps, instance quota`.

---

### Task 7: Emails service — create, batch, cancel, reschedule (TDD)

**Files:**

- Create: `apps/web/src/services/emails.ts`, `apps/web/src/services/email-events.ts`, `apps/web/src/lib/notify.ts`
- Modify: `apps/web/src/jobs/queues.ts` (`emailSend: "email.send"`, `webhookDeliver: "webhook.deliver"`, `retentionPurge: "retention.purge"`)
- Test: `apps/web/tests/integration/emails.test.ts`

- [ ] **Step 1: Failing test**

```ts
const ctx = {
  teamId: "org_1",
  source: "api" as const,
  apiKeyId: "key_1",
  actorUserId: null,
};
describe("createEmail", () => {
  it("validates, resolves the verified domain, applies tracking, stores attachments, records queued event, enqueues", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    const res = await createEmail(
      ctx,
      {
        from: "Acme <hello@mail.acme.com>",
        to: ["r@x.io"],
        subject: "Hi",
        html: '<p><a href="https://x.io">x</a></p>',
        attachments: [
          { filename: "a.txt", content: Buffer.from("hi").toString("base64") },
        ],
        tags: { k: "v" },
      },
      { enqueue },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const e = res.data;
    expect(e).toMatchObject({
      status: "queued",
      domainId: "dom_1",
      fromEmail: "hello@mail.acme.com",
      attachmentsMeta: [{ filename: "a.txt", size: 2 }],
    });
    expect(e.html).toContain("/t/c/" + e.id);
    expect(e.html).toContain(`/t/o/${e.id}.gif`);
    expect(enqueue).toHaveBeenCalledWith(
      "email.send",
      { emailId: e.id },
      undefined,
    );
    const { listEvents } = await import("@/services/email-events");
    expect((await listEvents(e.id)).map((x) => x.type)).toEqual(["queued"]);
  });
  it("rejects unverified/foreign domains, suppressed recipients (unless manual+override), reserved headers, caps", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    expect(
      await createEmail(
        ctx,
        { from: "a@unknown.io", to: ["r@x.io"], subject: "s", text: "t" },
        { enqueue },
      ),
    ).toMatchObject({ ok: false, code: "domain_not_verified" });
    const { suppressFromEvent, addSuppression } =
      await import("@/services/suppressions");
    await suppressFromEvent(
      "org_1",
      [{ email: "bounced@x.io", reason: "bounce" }],
      null,
    );
    expect(
      await createEmail(
        ctx,
        {
          from: "a@mail.acme.com",
          to: ["bounced@x.io"],
          subject: "s",
          text: "t",
          overrideSuppression: true,
        },
        { enqueue },
      ),
    ).toMatchObject({ ok: false, code: "suppressed_recipient" });
    await addSuppression(actor, { email: "manual@x.io", reason: "manual" });
    expect(
      (
        await createEmail(
          ctx,
          {
            from: "a@mail.acme.com",
            to: ["manual@x.io"],
            subject: "s",
            text: "t",
            overrideSuppression: true,
          },
          { enqueue },
        )
      ).ok,
    ).toBe(true);
  });
  it("scheduled sends enqueue with startAfter and status scheduled; idempotency returns the same id; conflict on different payload", async () => {
    const enqueue = vi.fn(async () => "job");
    const { createEmail } = await import("@/services/emails");
    const when = new Date(Date.now() + 3600_000).toISOString();
    const a = await createEmail(
      ctx,
      {
        from: "a@mail.acme.com",
        to: ["r@x.io"],
        subject: "s",
        text: "t",
        scheduledAt: when,
        idempotencyKey: "k1",
      },
      { enqueue },
    );
    expect(a).toMatchObject({ ok: true, data: { status: "scheduled" } });
    expect(enqueue).toHaveBeenCalledWith("email.send", expect.anything(), {
      startAfter: expect.any(Number),
    });
    const b = await createEmail(
      ctx,
      {
        from: "a@mail.acme.com",
        to: ["r@x.io"],
        subject: "s",
        text: "t",
        scheduledAt: when,
        idempotencyKey: "k1",
      },
      { enqueue },
    );
    expect(b.ok && a.ok && b.data.id === a.data.id).toBe(true);
    expect(
      await createEmail(
        ctx,
        {
          from: "a@mail.acme.com",
          to: ["other@x.io"],
          subject: "s",
          text: "t",
          idempotencyKey: "k1",
        },
        { enqueue },
      ),
    ).toMatchObject({ ok: false, code: "idempotency_conflict" });
  });
  it("cancel works for queued/scheduled only; reschedule updates scheduledAt", async () => {
    /* create scheduled → cancelEmail → status cancelled + event; cancel again → error; rescheduleEmail on a sent email → error */
  });
  it("sending-only key scoped to a domain cannot send from another domain", async () => {
    /* createEmail with ctx.keyDomainId = "dom_other" → forbidden */
  });
});
```

Write the two sketched cases in full (they're listed as intent; the implementer writes them out). Run → FAIL.

- [ ] **Step 2: Implement**

`lib/notify.ts`:

```ts
import { db } from "@/db";
import { sql } from "drizzle-orm";
export const teamChannel = (teamId: string) =>
  `ss_team_${teamId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
/** Best-effort Postgres NOTIFY for SSE listeners. Never throws. */
export async function notifyTeam(
  teamId: string,
  payload: { type: string; id?: string },
) {
  try {
    await db().execute(
      sql`select pg_notify(${teamChannel(teamId)}, ${JSON.stringify(payload)})`,
    );
  } catch (e) {
    console.warn("[notify]", (e as Error).message);
  }
}
```

`services/email-events.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";
import { newId } from "@sendsprite/shared";
import { db } from "@/db";
import { emailEvents, emails, type EmailEventType } from "@/db/schema";
import { notifyTeam } from "@/lib/notify";
const TERMINAL_RANK: Record<string, number> = {
  queued: 0,
  scheduled: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  delivery_delayed: 2,
  bounced: 4,
  complained: 5,
  rejected: 4,
  failed: 4,
  cancelled: 4,
};
const STATUS_FOR: Partial<
  Record<EmailEventType, typeof emails.$inferSelect.status>
> = {
  sent: "sent",
  delivered: "delivered",
  bounced: "bounced",
  complained: "complained",
  rejected: "failed",
  failed: "failed",
  cancelled: "cancelled",
};
/** Idempotent insert; updates the email status when the event outranks the current one. Returns the row or null when duplicate. */
export async function recordEvent(i: {
  emailId: string;
  teamId: string;
  type: EmailEventType;
  dedupeKey: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}) {
  const [row] = await db()
    .insert(emailEvents)
    .values({
      id: newId("evt"),
      emailId: i.emailId,
      teamId: i.teamId,
      type: i.type,
      dedupeKey: i.dedupeKey,
      payload: i.payload ?? {},
      occurredAt: i.occurredAt ?? new Date(),
    })
    .onConflictDoNothing({
      target: [emailEvents.emailId, emailEvents.dedupeKey],
    })
    .returning();
  if (!row) return null;
  const next = STATUS_FOR[i.type];
  if (next) {
    const [cur] = await db()
      .select({ status: emails.status })
      .from(emails)
      .where(eq(emails.id, i.emailId));
    if (cur && (TERMINAL_RANK[next] ?? 0) >= (TERMINAL_RANK[cur.status] ?? 0))
      await db()
        .update(emails)
        .set({
          status: next,
          ...(next === "sent" && { sentAt: i.occurredAt ?? new Date() }),
        })
        .where(eq(emails.id, i.emailId));
  }
  await notifyTeam(i.teamId, { type: "email", id: i.emailId });
  return row;
}
export const listEvents = (emailId: string) =>
  db()
    .select()
    .from(emailEvents)
    .where(eq(emailEvents.emailId, emailId))
    .orderBy(asc(emailEvents.occurredAt));
```

`services/emails.ts` (core):

```ts
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import {
  SendEmailInput,
  newId,
  type ErrorCode,
  type SendEmailInput as SendInput,
} from "@sendsprite/shared";
import { db } from "@/db";
import { domains, emailAttachments, emails, teamSettings } from "@/db/schema";
import { parseAddress, domainOf, normaliseEmail } from "@/lib/email-address";
import { injectPixel, wrapLinks } from "@/lib/tracking";
import { loadEnv } from "@/env.schema";
import { recordEvent } from "./email-events";
import { isSuppressed } from "./suppressions";
import { checkInstanceQuota, checkTeamCaps } from "./send-limits";
import type { Enqueue } from "./domains";
export interface SendContext {
  teamId: string;
  source: "api" | "smtp" | "campaign" | "dashboard";
  apiKeyId: string | null;
  actorUserId: string | null;
  keyDomainId?: string | null;
}
export type EmailRow = typeof emails.$inferSelect;
export type SendFailure = {
  ok: false;
  code: ErrorCode;
  error: string;
  details?: unknown;
};
export type SendResult = { ok: true; data: EmailRow } | SendFailure;
const fail = (
  code: ErrorCode,
  error: string,
  details?: unknown,
): SendFailure => ({ ok: false, code, error, details });
/** Longest-suffix match of the from-address domain against the team's verified domains. */
export async function resolveSendingDomain(teamId: string, fromEmail: string) {
  const d = domainOf(fromEmail);
  const rows = await db()
    .select()
    .from(domains)
    .where(and(eq(domains.teamId, teamId), eq(domains.status, "verified")));
  return (
    rows
      .filter((r) => d === r.name || d.endsWith(`.${r.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}
export async function createEmail(
  ctx: SendContext,
  raw: unknown,
  deps: { enqueue: Enqueue; now?: Date },
): Promise<SendResult> {
  const parsed = SendEmailInput.safeParse(raw);
  if (!parsed.success)
    return fail(
      "validation_error",
      parsed.error.issues[0]?.message ?? "Invalid request.",
      parsed.error.issues,
    );
  const input = parsed.data;
  const now = deps.now ?? new Date();
  const from = parseAddress(input.from);
  if (!from) return fail("validation_error", "from is not a valid address.");
  const rcpt = (list: string[]) =>
    list.map((s) => parseAddress(s)?.email ?? null);
  const to = rcpt(input.to),
    cc = rcpt(input.cc),
    bcc = rcpt(input.bcc),
    replyTo = rcpt(input.replyTo);
  if ([...to, ...cc, ...bcc, ...replyTo].some((x) => x === null))
    return fail("validation_error", "A recipient address is invalid.");
  const domain = await resolveSendingDomain(ctx.teamId, from.email);
  if (!domain)
    return fail(
      "domain_not_verified",
      `No verified sending domain for ${from.email}.`,
    );
  if (ctx.keyDomainId && ctx.keyDomainId !== domain.id)
    return fail("forbidden", "This API key is restricted to another domain.");
  if (input.idempotencyKey) {
    const [existing] = await db()
      .select()
      .from(emails)
      .where(
        and(
          eq(emails.teamId, ctx.teamId),
          eq(emails.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing) {
      const same =
        existing.subject === input.subject &&
        JSON.stringify(existing.to) === JSON.stringify(to);
      return same
        ? { ok: true, data: existing }
        : fail(
            "idempotency_conflict",
            "idempotencyKey was already used with a different payload.",
          );
    }
  }
  const all = [...to, ...cc, ...bcc] as string[];
  const sup = await isSuppressed(ctx.teamId, all);
  const blocking = sup.filter(
    (s) => !(input.overrideSuppression && s.reason === "manual"),
  );
  if (blocking.length)
    return fail(
      "suppressed_recipient",
      `Recipient is suppressed (${blocking[0]!.reason}): ${blocking[0]!.email}`,
      blocking,
    );
  const caps = await checkTeamCaps(ctx.teamId, 1, now);
  if (!caps.ok) return fail(caps.code, caps.message);
  const quota = await checkInstanceQuota(1, now);
  if (!quota.ok) return fail(quota.code, quota.message);
  const [ts] = await db()
    .select()
    .from(teamSettings)
    .where(eq(teamSettings.teamId, ctx.teamId));
  const trackOpens = input.trackOpens ?? ts?.trackOpens ?? true,
    trackClicks = input.trackClicks ?? ts?.trackClicks ?? true;
  const id = newId("em");
  const env = loadEnv();
  let html = input.html ?? null;
  if (html && trackClicks)
    html = wrapLinks(html, id, env.APP_URL, env.APP_SECRET);
  if (html && trackOpens) html = injectPixel(html, id, env.APP_URL);
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  const status =
    scheduledAt && scheduledAt.getTime() > now.getTime() + 5000
      ? "scheduled"
      : "queued";
  const attachmentsMeta = input.attachments.map((a) => ({
    id: newId("att"),
    filename: a.filename,
    contentType: a.contentType ?? "application/octet-stream",
    size: Buffer.from(a.content, "base64").length,
  }));
  const [row] = await db()
    .transaction(async (tx) => {
      const [r] = await tx
        .insert(emails)
        .values({
          id,
          teamId: ctx.teamId,
          apiKeyId: ctx.apiKeyId,
          domainId: domain.id,
          from: input.from,
          fromEmail: from.email,
          to: to as string[],
          cc: cc as string[],
          bcc: bcc as string[],
          replyTo: replyTo as string[],
          subject: input.subject,
          html,
          text: input.text ?? null,
          headers: input.headers,
          tags: input.tags,
          attachmentsMeta,
          trackOpens,
          trackClicks,
          status,
          source: ctx.source,
          idempotencyKey: input.idempotencyKey ?? null,
          scheduledAt,
        })
        .returning();
      if (input.attachments.length)
        await tx.insert(emailAttachments).values(
          input.attachments.map((a, i) => ({
            id: attachmentsMeta[i]!.id,
            emailId: id,
            filename: a.filename,
            contentType: attachmentsMeta[i]!.contentType,
            size: attachmentsMeta[i]!.size,
            bytes: Buffer.from(a.content, "base64"),
          })),
        );
      return [r!];
    })
    .catch((e) => {
      if ((e as { code?: string }).code === "23505") return [null];
      throw e;
    });
  if (!row)
    return fail("idempotency_conflict", "idempotencyKey was already used.");
  await recordEvent({
    emailId: id,
    teamId: ctx.teamId,
    type: "queued",
    dedupeKey: `local:${id}:queued`,
  });
  const delay = scheduledAt
    ? Math.max(0, Math.round((scheduledAt.getTime() - now.getTime()) / 1000))
    : 0;
  await deps.enqueue(
    "email.send",
    { emailId: id },
    delay > 0 ? { startAfter: delay } : undefined,
  );
  return { ok: true, data: row };
}
export async function createBatch(
  ctx: SendContext,
  raw: unknown,
  deps: { enqueue: Enqueue },
): Promise<{ ok: true; data: { id: string }[] } | SendFailure> {
  /* validate BatchSendInput (≤100); run createEmail sequentially; on first failure return it with details.index; else return ids */
}
export const getEmail = (teamId: string, id: string) =>
  db()
    .select()
    .from(emails)
    .where(and(eq(emails.id, id), eq(emails.teamId, teamId)))
    .then((r) => r[0] ?? null);
export async function listEmails(
  teamId: string,
  q: {
    limit: number;
    cursor?: string;
    status?: EmailRow["status"];
    to?: string;
    domainId?: string;
    tag?: string;
  },
) {
  /* keyset pagination on (created_at desc, id desc); cursor = base64(created_at|id); `to` = jsonb contains; `tag` = "k:v" */
}
export async function cancelEmail(
  teamId: string,
  id: string,
  actorUserId: string | null,
): Promise<SendResult> {
  /* only queued|scheduled → cancelled + event "cancelled"; note the pg-boss job stays but the handler checks status */
}
export async function rescheduleEmail(
  teamId: string,
  id: string,
  scheduledAt: string,
  deps: { enqueue: Enqueue },
): Promise<SendResult> {
  /* only scheduled; update scheduledAt; send a new job with startAfter; handler skips if scheduledAt is still in the future (guards the stale job) */
}
```

Write `createBatch`, `listEmails`, `cancelEmail`, `rescheduleEmail` out fully (the plan sketches their contracts; implement and test them — the tests in Step 1 cover cancel/reschedule and the test file must exercise `listEmails` pagination with 3 rows + limit 2).

- [ ] **Step 3: Run, commit** → `feat(web): emails service — create/batch/list/cancel/reschedule with tracking, suppression, limits`.

---

### Task 8: `email.send` job — SES send with rate limiting (TDD with SES mock)

**Files:**

- Create: `apps/web/src/jobs/handlers/email-send.ts`, `apps/web/src/services/ses-send.ts`
- Modify: `apps/web/src/jobs/handlers/index.ts`
- Test: `apps/web/tests/integration/email-send.test.ts`

- [ ] **Step 1: Failing test**

```ts
const ses = mockClient(SESv2Client);
describe("sendQueuedEmail", () => {
  it("sends via SESv2 Simple content with attachments, tags and headers; records ses_message_id and sent event", async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: "ses-1" });
    const { createEmail } = await import("@/services/emails");
    const created = await createEmail(
      ctx,
      {
        from: "Acme <hello@mail.acme.com>",
        to: ["r@x.io"],
        cc: ["c@x.io"],
        replyTo: ["re@mail.acme.com"],
        subject: "Hi",
        html: "<p>h</p>",
        text: "t",
        headers: { "X-Ref": "1" },
        attachments: [
          {
            filename: "a.txt",
            content: Buffer.from("hi").toString("base64"),
            contentType: "text/plain",
          },
        ],
      },
      { enqueue: async () => "" },
    );
    if (!created.ok) throw new Error(created.error);
    const { sendQueuedEmail } = await import("@/services/ses-send");
    const out = await sendQueuedEmail(created.data.id, {
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
        { Name: "ss_email", Value: created.data.id },
        { Name: "ss_team", Value: "org_1" },
      ]),
      ConfigurationOverrides: {
        Tracking: {
          OpenTrackingEnabled: "false",
          ClickTrackingEnabled: "false",
        },
      },
    });
    expect(input.Content?.Simple?.Headers).toEqual([
      { Name: "X-Ref", Value: "1" },
    ]);
    expect(input.Content?.Simple?.Attachments?.[0]).toMatchObject({
      FileName: "a.txt",
      ContentType: "text/plain",
    });
    const { getEmail } = await import("@/services/emails");
    const e = await getEmail("org_1", created.data.id);
    expect(e).toMatchObject({
      status: "sent",
      sesMessageId: "ses-1",
      attempts: 1,
    });
  });
  it("waits for a rate token: re-enqueues with startAfter and does not call SES", async () => {
    /* resetRateForTests(now) with rate 1 and tokens 0 → outcome "throttled", enqueue called with startAfter ≥ 1, SES not called, status still queued */
  });
  it("MessageRejected → failed (no retry); TooManyRequests → throws for pg-boss retry; skips cancelled and not-yet-due scheduled emails", async () => {
    /* three cases */
  });
  it("sandbox: SES MessageRejected 'Email address is not verified' maps to sandbox_restricted in lastError", async () => {});
});
```

Write the sketched cases fully. Run → FAIL.

- [ ] **Step 2: Implement**

`services/ses-send.ts`:

```ts
import { SendEmailCommand } from "@aws-sdk/client-sesv2";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { emailAttachments, emails } from "@/db/schema";
import { makeSes } from "@/lib/aws/clients";
import { resolveAwsContext } from "@/lib/aws/credentials";
import { formatAddress, parseAddress } from "@/lib/email-address";
import { getInstanceSettings } from "./instance-settings";
import { takeSesToken } from "./send-limits";
import { recordEvent } from "./email-events";
import type { Enqueue } from "./domains";
export type SendOutcome =
  | { outcome: "sent" }
  | { outcome: "throttled"; retryInMs: number }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string };
const NO_RETRY = new Set([
  "MessageRejected",
  "MailFromDomainNotVerifiedException",
  "AccountSuspendedException",
  "SendingPausedException",
  "BadRequestException",
]);
export async function sendQueuedEmail(
  emailId: string,
  deps: { enqueue: Enqueue; now?: Date },
): Promise<SendOutcome> {
  const now = deps.now ?? new Date();
  const [e] = await db().select().from(emails).where(eq(emails.id, emailId));
  if (!e) return { outcome: "skipped", reason: "missing" };
  if (e.status !== "queued" && e.status !== "scheduled")
    return { outcome: "skipped", reason: e.status };
  if (e.scheduledAt && e.scheduledAt.getTime() > now.getTime() + 1000)
    return { outcome: "skipped", reason: "not_due" }; // stale job after reschedule
  const token = await takeSesToken(now);
  if (!token.ok) {
    await deps.enqueue(
      "email.send",
      { emailId },
      { startAfter: Math.max(1, Math.ceil(token.retryInMs / 1000)) },
    );
    return { outcome: "throttled", retryInMs: token.retryInMs };
  }
  await db()
    .update(emails)
    .set({ status: "sending", attempts: e.attempts + 1 })
    .where(eq(emails.id, emailId));
  try {
    const ctx = await resolveAwsContext();
    const s = await getInstanceSettings();
    const atts = e.attachmentsMeta.length
      ? await db()
          .select()
          .from(emailAttachments)
          .where(eq(emailAttachments.emailId, emailId))
      : [];
    const from = parseAddress(e.from)!;
    const res = await makeSes(ctx).send(
      new SendEmailCommand({
        FromEmailAddress: formatAddress(from),
        Destination: {
          ToAddresses: e.to,
          ...(e.cc.length && { CcAddresses: e.cc }),
          ...(e.bcc.length && { BccAddresses: e.bcc }),
        },
        ...(e.replyTo.length && { ReplyToAddresses: e.replyTo }),
        ConfigurationSetName: s.sesConfigSet ?? undefined,
        ConfigurationOverrides: {
          Tracking: {
            OpenTrackingEnabled: "false",
            ClickTrackingEnabled: "false",
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
            ...(Object.keys(e.headers).length && {
              Headers: Object.entries(e.headers).map(([Name, Value]) => ({
                Name,
                Value,
              })),
            }),
            ...(atts.length && {
              Attachments: atts.map((a) => ({
                FileName: a.filename,
                ContentType: a.contentType,
                RawContent: a.bytes,
                ContentDisposition: "ATTACHMENT",
              })),
            }),
          },
        },
      }),
    );
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
      occurredAt: now,
    });
    return { outcome: "sent" };
  } catch (err) {
    const name = (err as { name?: string })?.name ?? "Error";
    const message = (err as Error)?.message ?? String(err);
    const sandbox = /not verified/i.test(message) && name === "MessageRejected";
    if (NO_RETRY.has(name)) {
      await db()
        .update(emails)
        .set({
          status: "failed",
          lastError: sandbox
            ? `sandbox_restricted: ${message}`
            : `${name}: ${message}`,
        })
        .where(eq(emails.id, emailId));
      await recordEvent({
        emailId,
        teamId: e.teamId,
        type: "failed",
        dedupeKey: `local:${emailId}:failed:${e.attempts + 1}`,
        payload: {
          name,
          message,
          code: sandbox ? "sandbox_restricted" : undefined,
        },
        occurredAt: now,
      });
      return { outcome: "failed", error: message };
    }
    await db()
      .update(emails)
      .set({ status: "queued", lastError: `${name}: ${message}` })
      .where(eq(emails.id, emailId));
    throw err; // pg-boss retries with backoff
  }
}
```

If `Content.Simple.Attachments` is missing from the installed SDK types, build a raw MIME with `nodemailer/lib/mime-node` (`bun add nodemailer`) into `Content.Raw.Data` instead — same fields, and set `From/To/Cc/Reply-To/Subject` headers yourself (Bcc via `Destination.BccAddresses` still works with Raw).

Handler `jobs/handlers/email-send.ts`:

```ts
import { registerQueue } from "../boss";
import { Q } from "../queues";
import { enqueue } from "../enqueue";
import { sendQueuedEmail } from "@/services/ses-send";
registerQueue<{ emailId: string }>(
  Q.emailSend,
  async (jobs) => {
    for (const j of jobs) await sendQueuedEmail(j.data.emailId, { enqueue });
  },
  {
    queue: {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 120,
    },
  },
);
```

On the final failed attempt (I3 pattern from Phase 2: `includeMetadata`), mark the email `failed` with `lastError` — copy the `finalAttempt` approach from `domain-provision.ts`.

- [ ] **Step 3: Run, commit** → `feat(web): email.send job — SESv2 send with token bucket, retries and failure classes`.

---

### Task 9: SNS ingestion → events, suppressions, webhook fan-out (TDD)

**Files:**

- Create: `apps/web/src/services/ingest.ts`
- Modify: `apps/web/src/app/api/webhooks/ses/route.ts` (Notification branch), `apps/web/src/jobs/queues.ts`
- Test: `apps/web/tests/integration/ses-ingest.test.ts`

- [ ] **Step 1: Failing test**

```ts
describe("ingestSesEvent", () => {
  it("attributes by ss_email tag, records the event once, updates status, suppresses on Permanent bounce, fans out webhooks", async () => {
    // fixture: a sent email em_1 (insert row with sesMessageId "ses-1"), a webhook subscribed to email.bounced
    const enqueue = vi.fn(async () => "");
    const { ingestSesEvent } = await import("@/services/ingest");
    const msg = {
      eventType: "Bounce",
      mail: {
        messageId: "ses-1",
        timestamp: "…",
        destination: ["r@x.io"],
        tags: { ss_email: ["em_1"], ss_team: ["org_1"] },
      },
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "r@x.io" }],
        timestamp: "…",
        feedbackId: "fb1",
      },
    };
    expect(await ingestSesEvent(msg, "sns-msg-1", { enqueue })).toEqual({
      ok: true,
      recorded: true,
    });
    expect(await ingestSesEvent(msg, "sns-msg-1", { enqueue })).toEqual({
      ok: true,
      recorded: false,
    }); // SNS at-least-once
    // email status bounced, suppression row r@x.io reason bounce, enqueue("webhook.deliver", { deliveryId }) once
  });
  it("falls back to ses_message_id when tags are absent; unknown message → ok:false ignored", async () => {});
  it("Open/Click from SES are ignored (we use our own tracking) but still ack", async () => {});
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

`services/ingest.ts`:

```ts
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { emails } from "@/db/schema";
import { parseSesEvent } from "@/lib/ses-events";
import { recordEvent } from "./email-events";
import { suppressFromEvent } from "./suppressions";
import { fanOutEvent } from "./webhooks";
import type { Enqueue } from "./domains";
const WEBHOOK_TYPE: Record<string, string> = {
  sent: "email.sent",
  delivered: "email.delivered",
  delivery_delayed: "email.delayed",
  bounced: "email.bounced",
  complained: "email.complained",
  rejected: "email.failed",
  failed: "email.failed",
};
export async function ingestSesEvent(
  raw: unknown,
  snsMessageId: string,
  deps: { enqueue: Enqueue },
): Promise<{ ok: true; recorded: boolean } | { ok: false; reason: string }> {
  const ev = parseSesEvent(raw);
  if (!ev) return { ok: false, reason: "unparseable_or_unsupported" };
  if (ev.type === "opened" || ev.type === "clicked")
    return { ok: true, recorded: false }; // own tracking is authoritative
  const [e] = ev.emailId
    ? await db().select().from(emails).where(eq(emails.id, ev.emailId))
    : await db()
        .select()
        .from(emails)
        .where(eq(emails.sesMessageId, ev.sesMessageId));
  if (!e) return { ok: false, reason: "unknown_email" };
  const row = await recordEvent({
    emailId: e.id,
    teamId: e.teamId,
    type: ev.type,
    dedupeKey: `sns:${snsMessageId}`,
    payload: { ...ev.payload, recipients: ev.recipients },
    occurredAt: ev.occurredAt,
  });
  if (!row) return { ok: true, recorded: false };
  if (ev.type === "sent" && !e.sesMessageId)
    await db()
      .update(emails)
      .set({ sesMessageId: ev.sesMessageId })
      .where(eq(emails.id, e.id));
  await suppressFromEvent(e.teamId, ev.suppress, e.id);
  const wt = WEBHOOK_TYPE[ev.type];
  if (wt)
    await fanOutEvent(
      e.teamId,
      wt,
      row.id,
      {
        email: publicEmail(e),
        event: {
          type: ev.type,
          occurredAt: ev.occurredAt.toISOString(),
          ...ev.payload,
          recipients: ev.recipients,
        },
      },
      deps,
    );
  return { ok: true, recorded: true };
}
export const publicEmail = (e: typeof emails.$inferSelect) => ({
  id: e.id,
  from: e.from,
  to: e.to,
  cc: e.cc,
  bcc: e.bcc,
  replyTo: e.replyTo,
  subject: e.subject,
  status: e.status,
  tags: e.tags,
  createdAt: e.createdAt.toISOString(),
  sentAt: e.sentAt?.toISOString() ?? null,
  scheduledAt: e.scheduledAt?.toISOString() ?? null,
  lastError: e.lastError,
});
```

`fanOutEvent` is defined in Task 10 — implement Task 10's `services/webhooks.ts` `fanOutEvent` stub first if working strictly in order (a no-op returning `[]` is acceptable until Task 10 fills it in; the test above asserts fan-out, so do Task 10's service before finishing this test, or write the stub + test expecting the stub and update in Task 10). Route change: in `api/webhooks/ses/route.ts` Notification branch, `JSON.parse(msg.Message)` → `ingestSesEvent(parsed, msg.MessageId, { enqueue })`; always 200 (log non-ok reasons). Also `sent` from local send and `Send` from SES both exist — the SNS one dedupes by `sns:` key and `recordEvent` rank logic keeps status `sent`.

- [ ] **Step 3: Run, commit** → `feat(web): SES event ingestion — attribution, idempotent events, suppressions, fan-out`.

---

### Task 10: Webhooks — service, delivery job, REST, UI (TDD)

**Files:**

- Create: `apps/web/src/services/webhooks.ts`, `apps/web/src/jobs/handlers/webhook-deliver.ts`, `apps/web/src/app/api/v1/webhooks/{route.ts,[id]/route.ts,[id]/test/route.ts}`, `apps/web/src/app/app/webhooks/{page.tsx,actions.ts,WebhooksPanel.tsx,[id]/page.tsx}`
- Test: `apps/web/tests/integration/webhooks.test.ts`

- [ ] **Step 1: Failing test**

```ts
describe("webhooks", () => {
  it("creates with generated secret (shown once), fans out only subscribed types, delivers with signature headers, records delivery", async () => {
    const { createWebhook, fanOutEvent, deliver } =
      await import("@/services/webhooks");
    const w = await createWebhook(actor, {
      url: "https://hooks.acme.com/x",
      events: ["email.delivered"],
    });
    if (!w.ok) throw new Error(w.error);
    expect(w.data.secret).toMatch(/^whsec_/);
    const enqueue = vi.fn(async () => "");
    const ids = await fanOutEvent(
      "org_1",
      "email.delivered",
      "evt_1",
      { hello: "world" },
      { enqueue },
    );
    expect(ids).toHaveLength(1);
    expect(
      await fanOutEvent("org_1", "email.bounced", "evt_2", {}, { enqueue }),
    ).toHaveLength(0);
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    }) as never;
    expect(await deliver(ids[0]!, { fetch: f, enqueue })).toMatchObject({
      status: "delivered",
      statusCode: 200,
    });
    const h = new Headers(calls[0]!.init.headers);
    const { verifyWebhookSignature } = await import("@sendsprite/shared");
    expect(
      verifyWebhookSignature(
        String(calls[0]!.init.body),
        h.get("sendsprite-signature")!,
        w.data.secret,
      ),
    ).toBe(true);
    expect(h.get("sendsprite-event-id")).toBe("evt_1");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      id: "evt_1",
      type: "email.delivered",
      data: { hello: "world" },
    });
  });
  it("retries on failure with the 1m/5m/30m/2h/8h schedule, marks exhausted, disables after 24h of failures", async () => {});
  it("test delivery endpoint sends a synthetic event; update/delete/list; members cannot manage", async () => {});
});
```

Run → FAIL.

- [ ] **Step 2: Service + handler**

`services/webhooks.ts`:

```ts
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import {
  can,
  newId,
  signWebhook,
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
  WEBHOOK_EVENT_TYPES,
  type WebhookEventType,
} from "@sendsprite/shared";
import { db } from "@/db";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { getCipher } from "@/lib/crypto";
import { recordAudit } from "@/lib/audit";
import { notifyTeam } from "@/lib/notify";
import type { Result } from "@/lib/result";
import type { TeamActor } from "./team";
import type { Enqueue } from "./domains";
import type { FetchLike } from "@/lib/cloudflare/client";
export const RETRY_SCHEDULE_S = [60, 300, 1800, 7200, 28800]; // after attempt 1..5
const DISABLE_AFTER_MS = 24 * 3600 * 1000;
const input = z.object({
  url: z
    .url()
    .refine(
      (u) => u.startsWith("https://") || process.env.NODE_ENV !== "production",
      "url must be https",
    ),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
  enabled: z.boolean().optional(),
});
export const listWebhooks = (teamId: string) =>
  db()
    .select()
    .from(webhooks)
    .where(eq(webhooks.teamId, teamId))
    .orderBy(desc(webhooks.createdAt));
export async function createWebhook(
  actor: TeamActor,
  raw: unknown,
): Promise<Result<{ id: string; secret: string }>> {
  /* can("webhooks.manage"); parse; secret = "whsec_" + 32 random bytes base64url; insert secretEnc; audit; return */
}
export async function updateWebhook(
  actor: TeamActor,
  id: string,
  raw: unknown,
): Promise<Result> {
  /* url/events/enabled; re-enabling clears failingSince/disabledReason; audit */
}
export async function deleteWebhook(
  actor: TeamActor,
  id: string,
): Promise<Result> {
  /* team-scoped delete; audit */
}
export async function rotateSecret(
  actor: TeamActor,
  id: string,
): Promise<Result<{ secret: string }>> {}
/** Creates a pending delivery per enabled webhook subscribed to `type` and enqueues it. Returns delivery ids. */
export async function fanOutEvent(
  teamId: string,
  type: string,
  eventId: string,
  data: Record<string, unknown>,
  deps: { enqueue: Enqueue },
): Promise<string[]> {
  const hooks = (await listWebhooks(teamId)).filter(
    (w) => w.enabled && w.events.includes(type),
  );
  const ids: string[] = [];
  for (const w of hooks) {
    const id = newId("whd");
    await db()
      .insert(webhookDeliveries)
      .values({
        id,
        webhookId: w.id,
        teamId,
        eventId,
        eventType: type,
        payload: {
          id: eventId,
          type,
          createdAt: new Date().toISOString(),
          data,
        },
      });
    await deps.enqueue("webhook.deliver", { deliveryId: id });
    ids.push(id);
  }
  return ids;
}
export async function deliver(
  deliveryId: string,
  deps: { fetch?: FetchLike; enqueue: Enqueue; now?: Date },
) {
  const now = deps.now ?? new Date();
  const f = deps.fetch ?? fetch;
  const [d] = await db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.id, deliveryId));
  if (!d || d.status === "delivered") return d ?? null;
  const [w] = await db()
    .select()
    .from(webhooks)
    .where(eq(webhooks.id, d.webhookId));
  if (!w || !w.enabled) {
    await db()
      .update(webhookDeliveries)
      .set({ status: "failed", responseExcerpt: "webhook disabled" })
      .where(eq(webhookDeliveries.id, deliveryId));
    return null;
  }
  const body = JSON.stringify(d.payload);
  const secret = getCipher().decrypt(w.secretEnc);
  const attempt = d.attempt + 1;
  let statusCode: number | null = null;
  let excerpt = "";
  try {
    const res = await f(w.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Sendsprite-Webhooks/1",
        [SIGNATURE_HEADER]: signWebhook(
          body,
          secret,
          Math.floor(now.getTime() / 1000),
        ),
        [EVENT_ID_HEADER]: d.eventId,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    statusCode = res.status;
    excerpt = (await res.text().catch(() => "")).slice(0, 500);
  } catch (e) {
    excerpt = (e as Error).message.slice(0, 500);
  }
  const okResp = statusCode !== null && statusCode >= 200 && statusCode < 300;
  if (okResp) {
    await db()
      .update(webhookDeliveries)
      .set({
        attempt,
        status: "delivered",
        statusCode,
        responseExcerpt: excerpt,
        deliveredAt: now,
        nextRetryAt: null,
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    if (w.failingSince)
      await db()
        .update(webhooks)
        .set({ failingSince: null })
        .where(eq(webhooks.id, w.id));
  } else {
    const delay = RETRY_SCHEDULE_S[attempt - 1];
    const failingSince = w.failingSince ?? now;
    await db()
      .update(webhooks)
      .set({ failingSince })
      .where(eq(webhooks.id, w.id));
    if (delay !== undefined) {
      await db()
        .update(webhookDeliveries)
        .set({
          attempt,
          status: "pending",
          statusCode,
          responseExcerpt: excerpt,
          nextRetryAt: new Date(now.getTime() + delay * 1000),
        })
        .where(eq(webhookDeliveries.id, deliveryId));
      await deps.enqueue(
        "webhook.deliver",
        { deliveryId },
        { startAfter: delay },
      );
    } else
      await db()
        .update(webhookDeliveries)
        .set({
          attempt,
          status: "exhausted",
          statusCode,
          responseExcerpt: excerpt,
          nextRetryAt: null,
        })
        .where(eq(webhookDeliveries.id, deliveryId));
    if (now.getTime() - failingSince.getTime() >= DISABLE_AFTER_MS)
      await db()
        .update(webhooks)
        .set({
          enabled: false,
          disabledReason: "Disabled after 24 hours of failed deliveries.",
        })
        .where(eq(webhooks.id, w.id));
  }
  await notifyTeam(d.teamId, { type: "webhook", id: d.webhookId });
  return (
    await db()
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, deliveryId))
  )[0]!;
}
export async function sendTestEvent(
  actor: TeamActor,
  id: string,
  deps: { enqueue: Enqueue },
): Promise<Result<{ deliveryId: string }>> {
  /* fanOutEvent restricted to this hook with type "email.delivered" and a synthetic payload { test: true } */
}
export const listDeliveries = (teamId: string, webhookId: string, limit = 50) =>
  db()
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.teamId, teamId),
        eq(webhookDeliveries.webhookId, webhookId),
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
export async function replayDelivery(
  actor: TeamActor,
  deliveryId: string,
  deps: { enqueue: Enqueue },
): Promise<Result> {
  /* reset attempt→0, status pending, enqueue */
}
```

Write the sketched functions fully. Handler `webhook-deliver.ts`: `registerQueue<{deliveryId}>(Q.webhookDeliver, jobs → deliver(id, { enqueue }), { queue: { retryLimit: 0, expireInSeconds: 60 } })` (retries are our own schedule). Add `"webhooks.manage"` already in the shared `ACTIONS`. REST: `GET/POST /api/v1/webhooks`, `PATCH/DELETE /api/v1/webhooks/[id]`, `POST /api/v1/webhooks/[id]/test`. UI: list (url, events chips, enabled/disabled Badge with reason, failing-since), create (url, event checkboxes) → secret shown once; detail page: deliveries table (event, attempt, status, code, time) with Replay; Rotate secret; Enable/Disable; Delete.

- [ ] **Step 3: Run, commit** → `feat(web): webhooks — signed deliveries with retry schedule, REST, dashboard`.

---

### Task 11: Tracking endpoints + SSE stream

**Files:**

- Create: `apps/web/src/app/t/o/[id]/route.ts`, `apps/web/src/app/t/c/[id]/route.ts`, `apps/web/src/app/api/stream/route.ts`, `apps/web/src/components/app/useTeamStream.ts`
- Test: `apps/web/tests/integration/tracking.test.ts`, `apps/web/tests/integration/stream.test.ts`

- [ ] **Step 1: Failing tests**

```ts
describe("tracking", () => {
  it("open pixel records opened once per (email, ua, day) and returns a gif", async () => {
    const { GET } = await import("@/app/t/o/[id]/route");
    const res = await GET(
      new Request("https://mail.acme.com/t/o/em_1.gif", {
        headers: { "user-agent": "ua" },
      }),
      { params: Promise.resolve({ id: "em_1.gif" }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    // second call same day/ua → no new event (dedupeKey "open:<ua-hash>:<yyyy-mm-dd>"); unknown id still 200
  });
  it("click redirects only with a valid signature and records clicked", async () => {
    const { signClick } = await import("@/lib/tracking");
    const env = (await import("@/env.schema")).loadEnv();
    const s = signClick("em_1", "https://x.io/a", env.APP_SECRET);
    const { GET } = await import("@/app/t/c/[id]/route");
    const ok = await GET(
      new Request(
        `https://mail.acme.com/t/c/em_1?u=${encodeURIComponent("https://x.io/a")}&s=${s}`,
      ),
      { params: Promise.resolve({ id: "em_1" }) },
    );
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("https://x.io/a");
    const bad = await GET(
      new Request(
        `https://mail.acme.com/t/c/em_1?u=${encodeURIComponent("https://evil.io")}&s=${s}`,
      ),
      { params: Promise.resolve({ id: "em_1" }) },
    );
    expect(bad.status).toBe(400);
  });
});
```

`stream.test.ts`: subscribe via `listenTeam(teamId, cb)` from `@/lib/notify`, call `notifyTeam`, expect the callback within 2 s; unsubscribe stops it.

- [ ] **Step 2: Implement**

Pixel route: 1×1 transparent GIF bytes (`Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")`), `recordEvent` with `dedupeKey: open:<sha256(ua).slice(0,12)>:<date>` and `type: "opened"`, payload `{ ip, userAgent }` (ip from `requestMeta`), fan-out `email.opened`. Never 404 (always the gif). Click route: parse `u`, `s`; `verifyClick`; allow only `http(s)`; `recordEvent` type `clicked` with dedupe `click:<sha256(url+ua).slice(0,16)>:<date>`; fan-out `email.clicked`; `302` with `cache-control: no-store`. Both mark `trackOpens/trackClicks` respect: if the email has tracking off, still redirect but don't record.

`lib/notify.ts` add:

```ts
import postgres from "postgres";
let listener: ReturnType<typeof postgres> | undefined;
/** Dedicated LISTEN connection (postgres-js `listen`). Returns an unsubscribe fn. */
export async function listenTeam(
  teamId: string,
  cb: (payload: string) => void,
): Promise<() => Promise<void>> {
  listener ??= postgres(process.env.DATABASE_URL!, { max: 1 });
  const { unlisten } = await listener.listen(teamChannel(teamId), cb);
  return unlisten;
}
```

SSE route `api/stream/route.ts`: `requireTeam()`; `ReadableStream` that writes `event: change\ndata: {...}\n\n` on each notification, a `: ping` comment every 25 s, cleans up on `req.signal` abort; headers `content-type: text/event-stream`, `cache-control: no-store`, `x-accel-buffering: no`. `useTeamStream()` client hook: `new EventSource("/api/stream")`, on `change` → `router.refresh()` (debounced 500 ms); used by the emails list/detail and webhooks detail (Task 12/14).

- [ ] **Step 3: Run, commit** → `feat(web): open/click tracking endpoints and SSE team stream`.

---

### Task 12: REST v1 — emails + domains routes (integration-tested through the handlers)

**Files:**

- Create: `apps/web/src/app/api/v1/emails/{route.ts,batch/route.ts,[id]/route.ts,[id]/cancel/route.ts}`, `apps/web/src/app/api/v1/domains/{route.ts,[id]/route.ts,[id]/verify/route.ts}`
- Test: `apps/web/tests/integration/rest-emails.test.ts`

- [ ] **Step 1: Failing test** (calls route handlers with real `Request`s and a real API key from Task 4; SES mocked; enqueue real via `@/jobs/enqueue` with `getBoss()` send-only)

```ts
describe("REST /api/v1/emails", () => {
  it("POST → 201 {id}; GET /:id → object with events; GET list → cursor pagination; PATCH reschedule; POST cancel; errors use the envelope", async () => {
    const post = await POST(
      req("/api/v1/emails", {
        method: "POST",
        body: {
          from: "a@mail.acme.com",
          to: "r@x.io",
          subject: "s",
          text: "t",
        },
      }),
    );
    expect(post.status).toBe(201);
    const { id } = await post.json();
    expect(id).toMatch(/^em_/);
    expect(post.headers.get("x-ratelimit-limit")).toBeTruthy();
    const bad = await POST(
      req("/api/v1/emails", {
        method: "POST",
        body: { from: "a@nope.io", to: "r@x.io", subject: "s", text: "t" },
      }),
    );
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({
      error: { code: "domain_not_verified" },
    });
    expect(
      (
        await POST(
          req("/api/v1/emails", {
            method: "POST",
            body: {},
            auth: "Bearer nope",
          }),
        )
      ).status,
    ).toBe(401);
    // batch: 2 ok → 201 {data:[{id},{id}]}; batch with an invalid item → 400 with details.index
    // list: ?limit=1 → 1 item + next cursor; second page
    // PATCH /:id {scheduledAt} on a queued email → 409/422 (only scheduled); cancel queued → 200 status cancelled
  });
});
```

Run → FAIL.

- [ ] **Step 2: Routes**

Common: `withApiKey`; body via `await req.json().catch(() => null)`; `fail("validation_error", …)` on null. Rate-limit headers on every response: `x-ratelimit-limit` (team daily cap or `sesDailyQuota` or `unlimited`), `x-ratelimit-remaining`, `x-ratelimit-reset` (next UTC midnight epoch) — computed by a small `rateHeaders(teamId)` in `lib/api-response.ts` using `send-limits`. `POST /emails` → `createEmail({ teamId, source: "api", apiKeyId, actorUserId: null, keyDomainId }, body, { enqueue })` → 201 `{ id }` (Resend-compatible). `POST /emails/batch` → `createBatch` → 201 `{ data: [{id}] }`. `GET /emails/[id]` → `{ ...publicEmail(e), events: [...] }`. `GET /emails` → `listEmails` → `{ data, nextCursor }`. `PATCH /emails/[id]` → `rescheduleEmail`. `POST /emails/[id]/cancel` → `cancelEmail`. Domains: `GET /domains` (list, public shape: id, name, status, dnsMode, region, records w/o cloudflareId, createdAt), `POST /domains` (`createDomain` with a synthetic admin actor), `GET /domains/[id]`, `POST /domains/[id]/verify` (`reverifyDomain`), `DELETE /domains/[id]`. `sending_only` keys get 403 on everything except `POST /emails*`.

- [ ] **Step 3: Run, commit** → `feat(web): REST v1 emails and domains endpoints with error envelope and rate headers`.

---

### Task 13: SMTP relay

**Files:**

- Create: `apps/web/src/smtp/server.ts`, `apps/web/src/smtp/inbound.ts`, `apps/web/src/smtp/tls.ts`
- Modify: `apps/web/src/instrumentation.ts`, `apps/web/src/jobs/shutdown.ts` (stop SMTP), `apps/web/src/env.schema.ts` (`SMTP_PORT` default 587, `SMTP_TLS_CERT`/`SMTP_TLS_KEY` optional paths, `SMTP_MAX_SIZE` default 10 MB), `Dockerfile` (`EXPOSE 3000 587`), `docker-compose.yml` (port 587), `apps/web/next.config.ts` (`serverExternalPackages` += `smtp-server`, `mailparser`, `selfsigned`)
- Test: `apps/web/tests/integration/smtp.test.ts` (uses `nodemailer` as a client)

- [ ] **Step 1: Failing test**

```ts
import nodemailer from "nodemailer";
describe("SMTP relay", () => {
  it("authenticates with an API key as password, parses the message and creates an email through the normal path", async () => {
    const { startSmtp, stopSmtp } = await import("@/smtp/server");
    const port = 20000 + Math.floor(Math.random() * 1000);
    await startSmtp({ port, host: "127.0.0.1", tls: "selfsigned" });
    const t = nodemailer.createTransport({
      host: "127.0.0.1",
      port,
      secure: false,
      auth: { user: "sendsprite", pass: apiKeySecret },
      tls: { rejectUnauthorized: false },
    });
    const info = await t.sendMail({
      from: "Acme <hello@mail.acme.com>",
      to: "r@x.io",
      subject: "Via SMTP",
      text: "hello",
      html: "<p>hello</p>",
      attachments: [{ filename: "a.txt", content: "hi" }],
    });
    expect(info.response).toMatch(/250/);
    const { listEmails } = await import("@/services/emails");
    const { data } = await listEmails("org_1", { limit: 1 });
    expect(data[0]).toMatchObject({
      subject: "Via SMTP",
      source: "smtp",
      attachmentsMeta: [{ filename: "a.txt" }],
    });
    await expect(
      nodemailer
        .createTransport({
          host: "127.0.0.1",
          port,
          auth: { user: "x", pass: "ss_live_bad" },
          tls: { rejectUnauthorized: false },
        })
        .sendMail({
          from: "a@mail.acme.com",
          to: "r@x.io",
          subject: "s",
          text: "t",
        }),
    ).rejects.toThrow(/535/);
    await stopSmtp();
  });
  it("returns 550 for an unverified from domain and 552 for oversized messages", async () => {});
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

`smtp/tls.ts`: `loadOrGenerateCert(): { key: string; cert: string }` — reads `SMTP_TLS_CERT/KEY` files if set, else `selfsigned.generate([{ name: "commonName", value: hostname }], { days: 3650, keySize: 2048 })` cached in memory (comment: self-signed → clients must disable verification; production should mount real certs).

`smtp/server.ts`:

```ts
import { SMTPServer } from "smtp-server";
import { authenticateApiKey } from "@/lib/api-auth";
import { handleInbound } from "./inbound";
import { loadOrGenerateCert } from "./tls";
let server: SMTPServer | undefined;
export async function startSmtp(opts: {
  port: number;
  host?: string;
  tls?: "selfsigned" | { key: string; cert: string };
  maxSize?: number;
}) {
  const tls =
    opts.tls === "selfsigned" || !opts.tls ? loadOrGenerateCert() : opts.tls;
  server = new SMTPServer({
    banner: "Sendsprite SMTP relay",
    size: opts.maxSize ?? 10 * 1024 * 1024,
    secure: false,
    key: tls.key,
    cert: tls.cert,
    allowInsecureAuth: true,
    authMethods: ["PLAIN", "LOGIN"],
    disabledCommands: [],
    onAuth: (auth, session, cb) => {
      void (async () => {
        const a = await authenticateApiKey(`Bearer ${auth.password ?? ""}`);
        if (!a.ok)
          return cb(
            Object.assign(new Error("Invalid API key"), { responseCode: 535 }),
          );
        cb(null, {
          user: {
            teamId: a.team.id,
            keyId: a.key.id,
            keyDomainId: a.key.domainId,
          },
        });
      })();
    },
    onData: (stream, session, cb) => {
      void handleInbound(stream, session).then(
        () => cb(),
        (e) =>
          cb(
            Object.assign(new Error(e.message), {
              responseCode: e.responseCode ?? 451,
            }),
          ),
      );
    },
  });
  await new Promise<void>((res, rej) =>
    server!
      .listen(opts.port, opts.host ?? "0.0.0.0", () => res())
      .once("error", rej),
  );
  console.info(`[smtp] listening on ${opts.port}`);
}
export async function stopSmtp() {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
}
```

`smtp/inbound.ts`: `simpleParser(stream)` → `createEmail({ teamId, source: "smtp", apiKeyId, actorUserId: null, keyDomainId }, { from: parsed.from.text, to: parsed.to addresses (fallback to envelope rcptTo), cc, replyTo, subject, html: parsed.html || undefined, text: parsed.text, headers: filtered custom X-* headers, attachments: parsed.attachments.map(base64) }, { enqueue })`; map `SendFailure` codes to SMTP responses: `domain_not_verified` → 550, `suppressed_recipient` → 550, `validation_error` → 501, `daily_quota_exceeded`/`rate_limited` → 452, else 451; `stream.sizeExceeded` → 552. `instrumentation.ts`: after worker start, if `env.SMTP_ENABLED` and `NEXT_RUNTIME==="nodejs"`, `startSmtp({ port: env.SMTP_PORT, tls: cert files or "selfsigned" })`; `shutdown.ts` calls `stopSmtp()`. Dockerfile `EXPOSE 3000 587`; compose `- "${SMTP_PORT:-587}:587"` (remove the Phase-2 comment). Note the container runs as non-root `bun`; 587 is unprivileged, fine.

- [ ] **Step 3: Run, commit** → `feat(web): SMTP relay on 587 (API key auth, STARTTLS, mailparser → send pipeline)`.

---

### Task 14: Email log UI + overview stats

**Files:**

- Create: `apps/web/src/app/app/emails/{page.tsx,[id]/page.tsx,EmailsTable.tsx,EmailDetail.tsx,actions.ts}`, `apps/web/src/services/stats.ts`, `apps/web/src/app/api/internal/emails/[id]/preview/route.ts` (sandboxed HTML)
- Modify: `apps/web/src/app/app/page.tsx`
- Test: `apps/web/tests/integration/stats.test.ts`

- [ ] **Step 1: Stats (TDD)**

```ts
describe("teamStats", () => {
  it("counts sends by window and computes delivery/bounce/complaint rates with SES thresholds", async () => {
    // seed 10 emails sent in last 24h: 8 delivered, 1 bounced, 1 complained (events)
    const { teamStats } = await import("@/services/stats");
    const s = await teamStats("org_1");
    expect(s.sent.today).toBe(10);
    expect(s.rates.delivered).toBeCloseTo(0.8);
    expect(s.rates.bounced).toBeCloseTo(0.1);
    expect(s.rates.complained).toBeCloseTo(0.1);
    expect(s.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "bounce" }),
        expect.objectContaining({ kind: "complaint" }),
      ]),
    );
  });
});
```

`services/stats.ts`: `teamStats(teamId)` → `{ sent: { today, d7, d30 }, rates: { delivered, bounced, complained } over last 30 d sent }`, `alerts` when bounce ≥ 4 % (warning) / 5 % (critical) or complaint ≥ 0.08 % / 0.1 % over the last 24 h with ≥ 20 sends; `instanceStats()` same across teams for the owner banner. Overview page: three metric tiles (`metric-xl`), rate tiles with `StatusDot`, alert banner (amber/red) per spec §12, recent 10 emails, domain health, existing checklist ("Create an API key" done when a key exists; "Send your first email" done when any email exists).

- [ ] **Step 2: Emails UI**

`/app/emails`: filters (status select, `to` contains, domain, tag `k:v`), table (to, subject, status `StatusDot`, domain, created, sent) with cursor pagination ("Load more"), `useTeamStream()` for live refresh. `/app/emails/[id]`: header (subject, from → to/cc/bcc, status, tags, source, api key prefix), tabs: **Preview** (`<iframe sandbox="" srcDoc>` — served through `/api/internal/emails/[id]/preview` with `content-security-policy: default-src 'none'; img-src data: https:; style-src 'unsafe-inline'` — as `srcdoc` with `sandbox` attributes, no scripts), **Text**, **Headers**, **Events** timeline (`recordEvent` rows with payload details: bounce type/diagnostic, smtp response, open UA/IP, click link), attachments list (name/size — download deferred), **Resend** (creates a new email from the same content via `createEmail` with `source: "dashboard"`, `can("emails.send")`), **Cancel** for queued/scheduled. `bodyPurgedAt` set → show "Body purged by retention".

- [ ] **Step 3: Commit** → `feat(web): email log and detail with events timeline, live stream, overview stats + alerts`.

---

### Task 15: Openers — retention purge, heartbeat persistence, verified-domain re-check, distinct audit actions

**Files:**

- Create: `apps/web/src/jobs/handlers/retention-purge.ts`
- Modify: `apps/web/src/jobs/handlers/heartbeat.ts`, `apps/web/src/lib/health.ts`, `apps/web/src/jobs/handlers/domain-verify.ts`, `apps/web/src/services/{aws-connect,cloudflare-connect,instance-settings}.ts`
- Test: `apps/web/tests/integration/retention.test.ts`, `worker.test.ts` (heartbeat row), `domains.test.ts` (recheck candidates), `aws-connect.test.ts` (action names)

- [ ] **Step 1: Retention (TDD)** — `purgeOldBodies(retentionDays, now)` nulls `html/text`, deletes `email_attachments`, sets `bodyPurgedAt` for emails older than N days not yet purged, in batches of 500; cron `15 3 * * *` (`Q.retentionPurge`, `retryLimit: 0`); reads `instance_settings.retention_days` (env `EMAIL_RETENTION_DAYS` only seeds the default — document, and remove the env var from `env.schema.ts`/README if unused elsewhere). Test: seed one old + one new email with attachments → old purged, new intact, idempotent.
- [ ] **Step 2: Heartbeat persistence** — `heartbeat.ts` upserts `worker_heartbeats(process_id = os.hostname()+":"+pid, last_seen_at = now())`; cron stays `*/5`. `health.ts` `collect()` adds `workerLastSeenSeconds` (min age across rows) and reports `worker: "running"` if any row is < 10 min old even when this process is `disabled` (separate-worker deployments); `degraded` if > 15 min and `WORKER_MODE !== "none"`. Test in `worker.test.ts`.
- [ ] **Step 3: Verified re-check** — extend `selectSweepCandidates()` with verified rows whose `lastCheckedAt` is > 24 h old; `verifyDomain` with `force` demotes to `pending` + `lastError` if SES reports non-SUCCESS (existing behaviour) and fans out `domain.failed`; `domain.verified` fan-out when a domain flips to verified (use `fanOutEvent`). Tests.
- [ ] **Step 4: Audit action names** — `updateInstanceSettings(patch, actor, { audit: true, action?: string })`; `aws-connect` uses `aws.connect` / `aws.disconnect` / `ses.production.request` (always writes a row, even if unchanged) / `ses.account.refresh` (only on change); `cloudflare-connect` `cloudflare.connect`/`cloudflare.disconnect`; settings form `instance.update`. Update existing tests that assert `instance.update`.
- [ ] **Step 5: Commit** → `feat(web): retention purge, worker heartbeat health, verified-domain re-check, audit action names`.

---

### Task 16: E2E + CI + docs

**Files:**

- Create: `apps/web/tests/e2e/send.spec.ts`
- Modify: `apps/web/src/lib/aws/fake-client.ts` (`SendEmailCommand` → `{ MessageId: "fake-<n>" }`), `README.md`, `docs/superpowers/specs/2026-08-24-sendsprite-design.md` ("as shipped" notes), `.github/workflows/ci.yml` (no change expected; verify e2e env has `SMTP_ENABLED=false` or a free port), plan status block

- [ ] **Step 1: e2e** — after the existing `setup` project: create API key in `/app/api-keys` (copy secret from the `CopyField` text), `POST /api/v1/emails` via `page.request` with the key from `mail.<suffix>` … the domain from `setup.spec.ts` is `pending`, so first mark it verified directly? Not possible from e2e — instead the fake SES `GetEmailIdentity` returns `SUCCESS` when `process.env.AWS_E2E_VERIFY === "1"` (set in playwright webServer env) so the sweep verifies the domain within ~2 min — too slow; alternative: add an internal, dev-only route? Simplest: e2e uses the **Instance settings** path to add the domain, then in the spec waits for `Re-verify` and clicks it (inline verify → with the fake returning SUCCESS the domain becomes `verified` immediately). Then send via API → expect 201 → open `/app/emails` → row visible with status `sent` (worker inline + fake SES) → open detail → events show `queued`, `sent`. Also SMTP: `SMTP_ENABLED=true` with `SMTP_PORT=2587` in the webServer env; use `nodemailer` inside the spec to send one message and assert it appears.
- [ ] **Step 2: Docs** — README: "Sending" section (API key, curl example, batch, scheduling, idempotency, attachments, tracking, webhooks + signature verification snippet, SMTP relay config incl. TLS note, suppressions, limits/headers), env rows (`SMTP_PORT`, `SMTP_TLS_CERT/KEY`, `SMTP_MAX_SIZE`; retention env removed/clarified). Spec §4/§7/§8 "as shipped" notes (SES tracking disabled in favour of own; webhook disable email deferred; REST templates/contacts in Phase 5). Plan: "Phase 3 status: COMPLETE" block with Phase 4 openers (SDK-facing: OpenAPI generation from shared zod, `sendsprite/react` render arrives as `html`, CLI `emails tail` uses `/api/stream` with API key auth — needs an API-key-authenticated SSE variant).
- [ ] **Step 3: Commit** → `test(web): e2e send via API and SMTP; docs for sending`.

---

## Self-review

**Spec coverage:** §4 pipeline — validate (T2/T7), suppression (T5/T7), rate check (T6/T8), render (html/text; templates Phase 5; `react` arrives as html via SDK Phase 4), row + enqueue (T7), worker SES send with config set (T8), SNS → events → suppression → webhooks (T9/T10), open/click (T11), scheduled/batch/cancel/reschedule (T7/T12), per-team token bucket honoring MaxSendRate/quota (T6 — instance-level bucket by design, team caps from `team_settings`), SSE (T11). §5 tables (T1; `emails.attachments` metadata + `email_attachments` bytes; `webhook_deliveries` + retry fields). §7 REST: emails/domains/api-keys/webhooks/suppressions (T4/T5/T10/T12); templates/contacts/campaigns → Phase 5; OpenAPI → Phase 4. §8 webhook format/headers/retry/disable (T10; owner email deferred). §12 errors: retry classes (T8), suppressed override (T7), SNS unknown ids logged (T9), health (T15), bounce/complaint banners (T14). Openers: retention, heartbeat, verified re-check, audit names (T15); SNS ingestion (T9); REST domains (T12); `worker.ts` in image / region drift / warning persistence — **not** included (carry to Phase 4 plan header as "ops" items).

**Placeholder scan:** sketched function bodies in T7 (`createBatch/listEmails/cancelEmail/rescheduleEmail`), T8/T9/T10 test cases, and T10 service functions are marked "write out fully" with their contracts and test expectations stated — implementers write the code; reviewers check against the stated contracts. No TBDs.

**Type consistency:** `Enqueue` imported from `services/domains.ts` everywhere (as in Phase 2); `SendContext`/`SendResult`/`SendFailure` from `services/emails.ts` used by T8 (via `getEmail`), T12, T13; `recordEvent` (T7) used by T8/T9/T11; `fanOutEvent(teamId, type, eventId, data, deps)` (T10) used by T9/T11/T15; `publicEmail` (T9) used by T12/T14; `FetchLike` from the Cloudflare client reused for webhook delivery; `ErrorCode`/`HTTP_STATUS` from shared used by `api-response.ts`; queue names in `Q` (T7 adds `emailSend`, `webhookDeliver`, `retentionPurge`).
