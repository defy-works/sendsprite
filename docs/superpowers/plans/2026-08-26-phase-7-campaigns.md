# Phase 7 — Campaigns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a designed email to a contact book — block editor, audience selection that honours both consent and suppression, scheduling, resumable fan-out, per-campaign stats — and give every recipient a working one-click unsubscribe.

**Architecture:** A campaign is a **recipient-row generator**. It materialises ordinary `emails` rows (`source: "campaign"`, `campaign_id`, `contact_id`) in resumable chunks and then gets out of the way: the existing `email.send` queue, SES token bucket, suppression checks, tracking, events, webhooks and billing metering all work unchanged. Fan-out is driven by a **cron sweep**, never by a handler enqueueing itself. Unsubscribe links are stateless HMACs over `(contactId, campaignId)` — no token rows, no write amplification.

**Tech Stack:** Next.js 16 (Turbopack) + React 19, Tailwind v4, Drizzle + Postgres 16, pg-boss, zod v4 contracts in `packages/shared`, Tiptap (constrained to inline marks) + dnd-kit for the editor, Playwright + vitest.

---

## How to read this plan

Logic-bearing modules — contracts, the block renderer, the unsubscribe token, the fan-out, the sweeps — carry **complete code**, because that is where correctness lives and where a wrong guess is expensive. Dashboard tasks carry **complete specifications and representative code** rather than final JSX: across Phases 4–6 every implementer improved on the plan's markup, and the parts that mattered were always the constraints, not the class names. Where a task says "the code wins", it means exactly that — verify the plan against what is in the repo, and report the difference instead of preserving the plan's mistake.

---

## Decisions

### 1. A campaign is a recipient-row generator; the send path is untouched

The temptation is to build a second send path optimised for bulk. Resist it. Every guarantee this product has — the SES rate token (`takeSesToken`), the atomic claim in `sendQueuedEmail`, suppression enforcement, open/click tracking, `email.*` events, webhook fan-out, billing metering off `metadata.count` — lives on the existing path. A parallel bulk path would have to reimplement all of it and would drift the moment either side changed.

So a campaign writes ordinary `emails` rows and enqueues ordinary `email.send` jobs. What makes them campaign rows is three columns and nothing else.

**Consequence to accept:** a 50 000-recipient campaign creates 50 000 `emails` rows. That is the same volume the API would create for the same send, retention already purges their bodies, and keyset pagination on the mail log already handles the count. Storage is not the reason to build a second path.

### 2. Fan-out is sweep-driven and resumable, never self-enqueued

A handler on an exclusive queue that enqueues itself has silently stalled twice in this codebase. The rule is recorded and it is absolute: **never self-enqueue on an exclusive queue; drive continuation from a cron sweep.**

`campaign.fan-out-sweep` runs every minute, picks up campaigns in `sending`, materialises **one bounded chunk** each, and returns. The next tick does the next chunk. A campaign of 50 000 with a 500-row chunk finishes in 100 ticks; raise the chunk size, not the recursion.

This also gives crash-resumability for free: progress is the `campaign_recipients` rows themselves, so a worker that dies mid-chunk loses at most one chunk's uncommitted work, and the next tick picks up exactly where the table says it stopped.

### 3. Suppression is joined at materialisation _and_ re-checked at send

Phase 6 kept consent (`contacts.subscribed`) and deliverability (`suppressions`) deliberately separate, and Decision 5 of that phase says the one place they legitimately meet is campaign recipient selection. This is that place.

Selection therefore takes contacts that are **subscribed** (consent) **and not suppressed** (deliverability). Both, not either.

But selection happens up to hours before the send — a scheduled campaign materialises when it starts, and a hard bounce can arrive in between. The existing send path already re-checks suppression, and that check stays. A recipient suppressed after materialisation is skipped at send time, exactly as an API send would be. Do not "optimise" that second check away because selection already filtered: they are checks at two different times, not a duplicate.

### 4. GET confirms, POST unsubscribes — link scanners are the reason

This is the single most likely bug in the phase, and it is invisible in testing.

Corporate mail security products (Defender, Proofpoint, Mimecast) **follow every link in an incoming message** to inspect it. If `GET /unsubscribe/:token` unsubscribes, a scanner silently unsubscribes recipients who never touched the mail, and the first symptom is a customer asking why their list is evaporating.

So:

- `GET /unsubscribe/:token` renders a page with a button. It changes nothing.
- `POST /unsubscribe/:token` performs the unsubscribe.
- The RFC 8058 one-click header pair (`List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`) tells conforming mail clients to POST directly, which is what makes Gmail's and Outlook's native unsubscribe button work.

The POST is deliberately **not** CSRF-protected: RFC 8058 requires an unauthenticated cross-origin POST from a mail client, and the token _is_ the authorisation. That is a considered exception, not an oversight, and it must be commented as one where it lives.

### 5. Unsubscribe tokens are stateless HMACs

`base64url(contactId.campaignId.HMAC-SHA256(contactId + "." + campaignId, APP_SECRET))`, compared with `timingSafeEqual`.

No rows, no retention story, no write amplification on a 50 000 send. It cannot be revoked individually — acceptable, because the only thing it authorises is _removing_ consent, which is never the dangerous direction. Rotating `APP_SECRET` invalidates every outstanding link; that is already true of stored AWS credentials, and is documented.

Unsubscribing is **idempotent** and must not leak: a valid token for an already-unsubscribed contact shows the same "you're unsubscribed" page as a fresh one, and an invalid token shows a generic failure that does not distinguish "bad signature" from "unknown contact".

### 6. The block renderer is pure, shared, and the only thing that produces campaign HTML

`renderBlocks(blocks) → { html, text }` lives in `packages/shared`, takes a validated block list, and returns table-based, inline-styled HTML plus a plain-text alternative. It is pure and unit-tested, the dashboard preview calls it, the send calls it, and there is no second implementation anywhere — the same seam discipline that stopped the Phase 6 template preview from disagreeing with a send.

Every string interpolated into the HTML goes through the existing `escapeHtml` from `packages/shared/src/template.ts`. A campaign body is authored by a customer's own staff, but "our own users are trusted" is how stored XSS reaches a dashboard.

**URL fields are the exception escaping does not cover.** `escapeHtml` makes `javascript:alert(1)` safe as _text_ and useless as an `href`. Blocks with a URL (button, image, link mark) must run their URL through a scheme allow-list of `http:`, `https:` and `mailto:` — this is Phase 6 opener 4, and campaigns are where it stops being optional, because a campaign body is rendered into a dashboard preview _and_ mailed to thousands of people.

### 7. Tiptap is scoped to inline marks, not to the document

The spec names Tiptap + dnd-kit. Taken literally that invites a rich-text editor that emits arbitrary HTML we then have to sanitise into email-safe HTML — the hard version of this problem.

Instead: **dnd-kit owns block order; Tiptap owns only the inside of a text block**, configured with a hard-limited mark set (bold, italic, link) and no node types beyond paragraph. The document structure is our typed block list, which is what gets stored and rendered. This honours the spec, keeps the stored shape ours, and means an escaped Tiptap upgrade cannot inject a `<script>` into a campaign.

If a task finds Tiptap fighting this constraint, **stop and report** rather than widening the mark set: a plain textarea with a documented inline-markup subset is a better outcome than an editor that can emit anything.

### 8. Counts are derived; the `counts` column is a cache

The spec puts a `counts jsonb` on `campaigns`. Keep it, but treat it as a **cache rebuilt from `emails`/`email_events`**, never as the authoritative tally incremented on each event. Incremented counters drift the first time a webhook retries or a worker dies mid-update, and a stats page that disagrees with the mail log is worse than one that takes an extra second to load.

The sweep that advances the campaign also refreshes its counts; the campaign page shows live derived numbers for a campaign still sending.

### 9. What Phase 7 does not include

Confirmed with the user before planning: **audit-log UI and the analytics overview move to Phase 8.** Campaigns write audit rows through the existing `recordAudit` (so a future UI finds them), but no audit UI is built here.

Also out: A/B tests, per-recipient send-time optimisation, drip sequences, and any `campaign.*` REST surface beyond what the dashboard needs.

---

## What already exists (verify before building anything)

Confirmed by reading the repo at `c6b39b4`:

| Thing                                    | State                                                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_SOURCES`                          | Already `["api","smtp","campaign","dashboard"]` — `"campaign"` is ready and unused.                                                 |
| `emails.campaign_id` / `contact_id`      | **Do not exist.** The spec lists them; they were never added. Task 4 adds them.                                                     |
| `campaigns.manage`                       | Already in `packages/shared/src/roles.ts`, granted to owner + admin, **not** member.                                                |
| `email.send` queue                       | Standard policy, `{ emailId }`, atomic claim, 5 retries. Duplicates are safe.                                                       |
| `email.queued-sweep`                     | Every 2 min, re-enqueues due `queued`/`scheduled` rows whose job was lost. Campaign rows inherit this.                              |
| Sweep pattern                            | `domain.verify-sweep`, `webhook.retry-sweep`, `billing.meter-sweep` — cron, `retryLimit: 0`.                                        |
| `takeSesToken`                           | SES rate bucket in `services/send-limits.ts`.                                                                                       |
| `isSuppressed`                           | `services/suppressions.ts:55`.                                                                                                      |
| `listContactsPage`, `getBook`            | `services/contacts.ts` — audience reads.                                                                                            |
| `escapeHtml`                             | `packages/shared/src/template.ts`. Escapes `& < > " ' \` =`.                                                                        |
| Tracking routes                          | `/t/o/:id`, `/t/c/:id` exist.                                                                                                       |
| Tiptap / dnd-kit                         | **Not installed.** Task 13 adds them.                                                                                               |
| `signWebhook` / `verifyWebhookSignature` | `packages/shared/src/api/webhook-signature.ts`, exported from `node.ts` (needs `node:crypto`). Same home for the unsubscribe token. |
| Migrations                               | Latest is `0013_templates_contacts.sql`. Phase 7 is `0014`.                                                                         |

---

## File structure

**`packages/shared`** (contracts and pure logic; published, so no `node:` imports outside `node.ts`)

- `src/api/campaigns.ts` — `CampaignBlock` union, `CreateCampaignInput`, `UpdateCampaignInput`, `CampaignObject`, `CampaignStatus`, audience/schedule inputs.
- `src/campaign-render.ts` — `renderBlocks(blocks) → { html, text }`, `safeUrl(raw)`. Pure, no crypto, no DOM.
- `src/api/unsubscribe-token.ts` — `signUnsubscribeToken` / `verifyUnsubscribeToken`. Uses `node:crypto`, so it is exported from `node.ts` only.

**`apps/web`**

- `src/db/schema/campaigns.ts` — `campaigns`, `campaignRecipients`; `emails.campaignId`/`contactId` added to `schema/emails.ts`.
- `drizzle/0014_campaigns.sql`.
- `src/services/campaigns/crud.ts` — create/update/delete/list/get, all permission-checked and audited.
- `src/services/campaigns/audience.ts` — recipient counting and selection (the consent ∩ deliverability join).
- `src/services/campaigns/fanout.ts` — one chunk of materialisation; resumable, idempotent.
- `src/services/campaigns/stats.ts` — derived counts.
- `src/services/unsubscribe.ts` — token verification → `unsubscribeContact`, plus the `List-Unsubscribe` header pair.
- `src/jobs/handlers/campaign-fanout.ts` — the sweep and the schedule flip.
- `src/app/api/v1/campaigns/**` — REST.
- `src/app/(unsubscribe)/unsubscribe/[token]/{page.tsx,actions.ts}` — public, unauthenticated.
- `src/app/app/campaigns/**` — list, editor, audience/schedule, stats.

**`packages/sdk`** — `src/resources/campaigns.ts` + parity tuple entries.

---

## Task 1: Shared contracts — `packages/shared/src/api/campaigns.ts`

**Files:**

- Create: `packages/shared/src/api/campaigns.ts`, `packages/shared/tests/campaigns.test.ts`
- Modify: `packages/shared/src/index.ts` (re-export)

Read `packages/shared/src/api/contacts.ts` and `api/templates.ts` first. Every schema must stay `z.toJSONSchema`-representable: `.refine`/`.superRefine` are fine, `.trim()`/`.toLowerCase()` are `overwrite` checks that keep the string type, a `.transform()` is not.

- [ ] **Step 1: Write the failing test**

`packages/shared/tests/campaigns.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CampaignBlock,
  CreateCampaignInput,
  MAX_BLOCKS,
  UpdateCampaignInput,
} from "../src/api/campaigns";

describe("CampaignBlock", () => {
  it("accepts each block kind", () => {
    const blocks = [
      { kind: "heading", level: 1, text: "Hello" },
      { kind: "text", html: "Hi <strong>there</strong>" },
      { kind: "button", label: "Read", url: "https://example.com" },
      { kind: "image", url: "https://example.com/a.png", alt: "A" },
      { kind: "divider" },
      { kind: "spacer", size: 24 },
    ];
    for (const b of blocks)
      expect(CampaignBlock.safeParse(b).success).toBe(true);
  });

  it("refuses a javascript: URL on a button", () => {
    const r = CampaignBlock.safeParse({
      kind: "button",
      label: "Click",
      url: "javascript:alert(1)",
    });
    expect(r.success).toBe(false);
  });

  it("refuses a protocol-relative URL, which inherits the page scheme", () => {
    const r = CampaignBlock.safeParse({
      kind: "image",
      url: "//evil.test/a.png",
      alt: "x",
    });
    expect(r.success).toBe(false);
  });

  it("refuses control characters in heading text", () => {
    expect(
      CampaignBlock.safeParse({ kind: "heading", level: 2, text: "a	b" })
        .success,
    ).toBe(false);
  });

  it("refuses a text block carrying markup the editor cannot emit", () => {
    expect(
      CampaignBlock.safeParse({ kind: "text", html: "<script>x</script>" })
        .success,
    ).toBe(false);
    expect(
      CampaignBlock.safeParse({ kind: "text", html: '<img src=x onerror=y>' })
        .success,
    ).toBe(false);
  });
});

describe("CreateCampaignInput", () => {
  const base = {
    name: "August newsletter",
    bookId: "cb_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    domainId: "dom_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    from: "Acme <hello@mail.acme.com>",
    subject: "What we shipped",
    blocks: [{ kind: "text", html: "Hello" }],
  };

  it("accepts a minimal campaign", () => {
    expect(CreateCampaignInput.safeParse(base).success).toBe(true);
  });

  it("refuses a subject with a tab, like every other send path", () => {
    const r = CreateCampaignInput.safeParse({
      ...base,
      subject: "a	b",
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.message).toMatch(/control characters/);
  });

  it("trims the subject so a whitespace-only one is refused", () => {
    expect(
      CreateCampaignInput.safeParse({ ...base, subject: "   " }).success,
    ).toBe(false);
  });

  it("caps the block count", () => {
    const blocks = Array.from({ length: MAX_BLOCKS + 1 }, () => ({
      kind: "divider" as const,
    }));
    expect(CreateCampaignInput.safeParse({ ...base, blocks }).success).toBe(
      false,
    );
  });

  it("refuses an empty block list — a campaign with no body is a mistake", () => {
    expect(CreateCampaignInput.safeParse({ ...base, blocks: [] }).success).toBe(
      false,
    );
  });

  it("makes every field optional on update but keeps the same checks", () => {
    expect(UpdateCampaignInput.safeParse({}).success).toBe(true);
    expect(UpdateCampaignInput.safeParse({ subject: "a
b" }).success).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && bunx vitest run tests/campaigns.test.ts`
Expected: FAIL — `Cannot find module '../src/api/campaigns'`.

- [ ] **Step 3: Write the contract**

`packages/shared/src/api/campaigns.ts`:

```ts
import { z } from "zod";
import { NO_CONTROL_CHARS } from "../template";
import { EmailAddressField } from "./emails";

/**
 * Contracts for `/api/v1/campaigns` (spec §5, §10).
 *
 * A campaign's body is a typed block list, not free HTML. That is the whole
 * safety model: we render the blocks ourselves into table-based email HTML, so
 * there is no arbitrary markup to sanitise and no path from the editor to a
 * `<script>`. The one field that carries markup is `text.html`, restricted to
 * the inline marks the editor can produce (see `INLINE_HTML_RE`).
 */

export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "cancelled",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const MAX_BLOCKS = 100;
export const MAX_BLOCK_TEXT_CHARS = 10_000;
export const MAX_CAMPAIGN_NAME_CHARS = 200;
/** RFC 5322 line-length ceiling, matching `SendEmailInput`. */
export const MAX_SUBJECT_CHARS = 998;
export const MAX_URL_CHARS = 2_048;

/**
 * Schemes allowed anywhere a block carries a URL.
 *
 * `escapeHtml` makes `javascript:alert(1)` safe as *text* and completely
 * useless as an `href` — escaping never touched the scheme. Phase 6 recorded
 * this as opener 4; campaigns are where it stops being optional, because a
 * campaign body is rendered into a dashboard preview and mailed to thousands.
 *
 * `new URL()` also rejects protocol-relative `//host/path`, which would
 * otherwise inherit whatever scheme the reader's client used.
 */
const SAFE_SCHEMES = ["http:", "https:", "mailto:"];

export const SafeUrl = z
  .string()
  .trim()
  .min(1)
  .max(MAX_URL_CHARS)
  .refine((raw) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    return SAFE_SCHEMES.includes(u.protocol);
  }, "URL must be absolute and start with http://, https:// or mailto:.");

/** Plain text inside a block: no control characters, same rule as a subject. */
const BlockText = z
  .string()
  .max(MAX_BLOCK_TEXT_CHARS)
  .regex(NO_CONTROL_CHARS, "Text must not contain control characters.");

/**
 * The only markup a `text` block may carry. The editor emits exactly these —
 * Tiptap is configured with no other marks and no other nodes — so anything
 * else is either a hand-crafted payload or a regression in the editor, and we
 * would rather refuse both than render them.
 *
 * Anchors are matched with their full opening tag including the scheme, so
 * there is no way to smuggle an attribute (`onclick=`, `style=`) past this.
 */
const INLINE_HTML_RE =
  /^(?:[^<>]|<\/?(?:strong|em)>|<br\s?\/?>|<a href="(?:https?|mailto):[^"<>]*">|<\/a>)*$/;

const InlineHtml = z
  .string()
  .max(MAX_BLOCK_TEXT_CHARS)
  .regex(NO_CONTROL_CHARS, "Text must not contain control characters.")
  .regex(
    INLINE_HTML_RE,
    "Only bold, italic, line breaks and http(s)/mailto links are allowed here.",
  );

export const HeadingBlock = z.object({
  kind: z.literal("heading"),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  text: BlockText,
});

export const TextBlock = z.object({
  kind: z.literal("text"),
  html: InlineHtml,
});

export const ButtonBlock = z.object({
  kind: z.literal("button"),
  label: BlockText.max(200),
  url: SafeUrl,
});

export const ImageBlock = z.object({
  kind: z.literal("image"),
  url: SafeUrl,
  /**
   * Required, not optional. An image with no alt text is invisible to a screen
   * reader and to every client that blocks images by default — which is most
   * of them, on first open.
   */
  alt: BlockText.max(300),
  href: SafeUrl.optional(),
});

export const DividerBlock = z.object({ kind: z.literal("divider") });

export const SpacerBlock = z.object({
  kind: z.literal("spacer"),
  size: z.number().int().min(4).max(96),
});

export const CampaignBlock = z.discriminatedUnion("kind", [
  HeadingBlock,
  TextBlock,
  ButtonBlock,
  ImageBlock,
  DividerBlock,
  SpacerBlock,
]);
export type CampaignBlock = z.infer<typeof CampaignBlock>;

const Blocks = z
  .array(CampaignBlock)
  .min(1, "A campaign needs at least one block.")
  .max(MAX_BLOCKS, `A campaign may have at most ${MAX_BLOCKS} blocks.`);

/**
 * Trimmed before the control-character check, and the check runs on the
 * trimmed value: a whitespace-only subject must fail `min(1)` rather than
 * reach the MIME message as a blank header. Same ordering as `SendEmailInput`.
 */
const Subject = z
  .string()
  .trim()
  .min(1, "Subject is required.")
  .max(MAX_SUBJECT_CHARS)
  .regex(
    NO_CONTROL_CHARS,
    "Subject must not contain line breaks or control characters.",
  );

export const CreateCampaignInput = z.object({
  name: z.string().trim().min(1).max(MAX_CAMPAIGN_NAME_CHARS),
  bookId: z.string().min(1).max(64),
  domainId: z.string().min(1).max(64),
  from: EmailAddressField,
  replyTo: EmailAddressField.optional(),
  subject: Subject,
  blocks: Blocks,
});
export type CreateCampaignInput = z.infer<typeof CreateCampaignInput>;

/**
 * Every field optional, every check identical. Written out rather than
 * `.partial()` so a reader can see the subject rule did not quietly weaken on
 * the update path — that asymmetry has let bad values in before.
 */
export const UpdateCampaignInput = z.object({
  name: z.string().trim().min(1).max(MAX_CAMPAIGN_NAME_CHARS).optional(),
  bookId: z.string().min(1).max(64).optional(),
  domainId: z.string().min(1).max(64).optional(),
  from: EmailAddressField.optional(),
  replyTo: EmailAddressField.nullable().optional(),
  subject: Subject.optional(),
  blocks: Blocks.optional(),
});
export type UpdateCampaignInput = z.infer<typeof UpdateCampaignInput>;

/** Sending starts immediately when `scheduledAt` is absent. */
export const ScheduleCampaignInput = z.object({
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
});
export type ScheduleCampaignInput = z.infer<typeof ScheduleCampaignInput>;

export const CampaignCounts = z.object({
  recipients: z.number().int().nonnegative(),
  sent: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  opened: z.number().int().nonnegative(),
  clicked: z.number().int().nonnegative(),
  unsubscribed: z.number().int().nonnegative(),
  bounced: z.number().int().nonnegative(),
  complained: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type CampaignCounts = z.infer<typeof CampaignCounts>;

export const CampaignObject = z.object({
  id: z.string(),
  name: z.string(),
  bookId: z.string(),
  domainId: z.string(),
  from: z.string(),
  replyTo: z.string().nullable(),
  subject: z.string(),
  blocks: z.array(CampaignBlock),
  status: z.enum(CAMPAIGN_STATUSES),
  scheduledAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  counts: CampaignCounts,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CampaignObject = z.infer<typeof CampaignObject>;

/** What the audience card shows before anyone commits to sending. */
export const AudiencePreview = z.object({
  contacts: z.number().int().nonnegative(),
  subscribed: z.number().int().nonnegative(),
  suppressed: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative(),
});
export type AudiencePreview = z.infer<typeof AudiencePreview>;
```

- [ ] **Step 4: Re-export and run the tests**

Add to `packages/shared/src/index.ts`, in the existing run of `export *` lines:

```ts
export * from "./api/campaigns";
```

Run: `cd packages/shared && bunx vitest run tests/campaigns.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Check the OpenAPI emitter still likes it**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/openapi-coverage.test.ts`
Expected: PASS. If `z.toJSONSchema` throws on a schema here the cause is a `.transform()` — replace it. Do **not** exclude the schema from the emitter to make the error go away.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/api/campaigns.ts packages/shared/src/index.ts packages/shared/tests/campaigns.test.ts
git commit -m "feat(shared): campaign contracts with a typed block union"
```

---

## Task 2: The block renderer — `packages/shared/src/campaign-render.ts`

Pure, shared, and the **only** thing that turns blocks into HTML. The dashboard preview and the send both call it, so a preview cannot disagree with what recipients receive — the seam discipline Phase 6 applied to templates.

**Files:**

- Create: `packages/shared/src/campaign-render.ts`, `packages/shared/tests/campaign-render.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/tests/campaign-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderBlocks, UNSUBSCRIBE_MARKER } from "../src/campaign-render";
import type { CampaignBlock } from "../src/api/campaigns";

const render = (blocks: CampaignBlock[]) => renderBlocks(blocks);

describe("renderBlocks", () => {
  it("escapes heading text rather than trusting it", () => {
    const { html } = render([
      { kind: "heading", level: 1, text: '<img src=x onerror="alert(1)">' },
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("emits table-based markup, not flexbox", () => {
    const { html } = render([{ kind: "text", html: "Hello" }]);
    expect(html).toContain("<table");
    expect(html).not.toMatch(/display:\s*flex/);
  });

  it("renders a button as a table cell with an anchor, not a <button>", () => {
    const { html } = render([
      { kind: "button", label: "Read more", url: "https://example.com/a" },
    ]);
    expect(html).toContain('href="https://example.com/a"');
    expect(html).not.toContain("<button");
  });

  it("produces a text alternative that keeps link targets", () => {
    const { text } = render([
      { kind: "text", html: 'See <a href="https://example.com/x">this</a>' },
      { kind: "button", label: "Read more", url: "https://example.com/a" },
    ]);
    expect(text).toContain("this (https://example.com/x)");
    expect(text).toContain("Read more (https://example.com/a)");
  });

  it("keeps the inline marks the editor can emit", () => {
    const { html } = render([{ kind: "text", html: "a <strong>b</strong> c" }]);
    expect(html).toContain("<strong>b</strong>");
  });

  it("gives every image an alt attribute", () => {
    const { html } = render([
      { kind: "image", url: "https://example.com/a.png", alt: "A cat" },
    ]);
    expect(html).toMatch(/<img[^>]+alt="A cat"/);
  });

  it("leaves exactly one unsubscribe marker in each part", () => {
    const { html, text } = render([{ kind: "text", html: "Hi" }]);
    expect(html.split(UNSUBSCRIBE_MARKER)).toHaveLength(2);
    expect(text.split(UNSUBSCRIBE_MARKER)).toHaveLength(2);
  });

  it("is deterministic — the same blocks render byte-identically", () => {
    const blocks: CampaignBlock[] = [
      { kind: "heading", level: 2, text: "Hi" },
      { kind: "divider" },
    ];
    expect(render(blocks).html).toBe(render(blocks).html);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && bunx vitest run tests/campaign-render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the renderer**

`packages/shared/src/campaign-render.ts`:

```ts
import type { CampaignBlock } from "./api/campaigns";
import { escapeHtml } from "./template";

/**
 * Blocks → email-safe HTML and a plain-text alternative.
 *
 * Pure and deterministic: no clock, no randomness, no network. The dashboard
 * preview and the send both call this, which is what stops a preview from
 * disagreeing with what recipients receive.
 *
 * ## Why tables and inline styles
 *
 * Outlook on Windows renders with Word's HTML engine: no flexbox, no grid, no
 * dependable `<style>` support, and most external CSS ignored. Table cells
 * with inline `style` attributes are the only layout that behaves the same in
 * Gmail, Outlook, Apple Mail and the long tail. This is the current
 * compatibility floor, not nostalgia.
 */

/**
 * Substituted per recipient by the fan-out (Task 7), because every recipient
 * needs a different unsubscribe link and this renderer is pure.
 *
 * Deliberately *not* the `{{name}}` syntax templates use: this is not a
 * customer-supplied placeholder, and nothing a customer writes may resolve it.
 */
export const UNSUBSCRIBE_MARKER = "�UNSUBSCRIBE�";

const FONT =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const INK = "#111111";
const MUTED = "#6b7280";
const ACCENT = "#4f46e5";

const HEADING_SIZE: Record<1 | 2 | 3, string> = {
  1: "28px",
  2: "22px",
  3: "18px",
};

/** One full-width row wrapping a block's own markup. */
function row(inner: string): string {
  return `<tr><td style="padding:0 24px">${inner}</td></tr>`;
}

function renderBlock(b: CampaignBlock): string {
  switch (b.kind) {
    case "heading":
      return row(
        `<h${b.level} style="${FONT};font-size:${HEADING_SIZE[b.level]};line-height:1.3;color:${INK};margin:24px 0 8px">${escapeHtml(b.text)}</h${b.level}>`,
      );
    case "text":
      // Not escaped: `InlineHtml` in the contract already restricted this to
      // <strong>, <em>, <br> and http(s)/mailto anchors. Escaping here would
      // render those marks as visible tags.
      return row(
        `<p style="${FONT};font-size:16px;line-height:1.6;color:${INK};margin:0 0 16px">${b.html}</p>`,
      );
    case "button":
      // A table around the anchor: Outlook ignores padding on inline elements,
      // so the cell has to provide the hit area.
      return row(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td style="background:${ACCENT};border-radius:6px"><a href="${escapeHtml(b.url)}" style="${FONT};display:inline-block;padding:12px 24px;font-size:16px;color:#ffffff;text-decoration:none">${escapeHtml(b.label)}</a></td></tr></table>`,
      );
    case "image": {
      const img = `<img src="${escapeHtml(b.url)}" alt="${escapeHtml(b.alt)}" style="display:block;width:100%;max-width:552px;height:auto;border:0" />`;
      return row(
        b.href
          ? `<a href="${escapeHtml(b.href)}" style="text-decoration:none">${img}</a>`
          : img,
      );
    }
    case "divider":
      return row(
        `<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0" />`,
      );
    case "spacer":
      return row(
        `<div style="height:${b.size}px;line-height:${b.size}px;font-size:0">&nbsp;</div>`,
      );
  }
}

/** Strips the allowed inline marks, keeping link targets visible. */
function blockToText(b: CampaignBlock): string {
  switch (b.kind) {
    case "heading":
      return b.text;
    case "text":
      return b.html
        .replace(
          /<a href="([^"]*)">([\s\S]*?)<\/a>/g,
          (_m, href: string, label: string) => `${label} (${href})`,
        )
        .replace(/<br\s?\/?>/g, "\n")
        .replace(/<\/?(?:strong|em)>/g, "");
    case "button":
      return `${b.label} (${b.url})`;
    case "image":
      return b.alt ? `[${b.alt}]` : "";
    case "divider":
      return "---";
    case "spacer":
      return "";
  }
}

export interface RenderedCampaign {
  html: string;
  text: string;
}

export function renderBlocks(blocks: CampaignBlock[]): RenderedCampaign {
  const body = blocks.map(renderBlock).join("");
  const html =
    `<!doctype html><html><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width,initial-scale=1" /></head>` +
    `<body style="margin:0;padding:0;background:#f3f4f6">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f4f6">` +
    `<tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:8px">` +
    body +
    `<tr><td style="padding:8px 24px 24px">` +
    `<p style="${FONT};font-size:12px;line-height:1.5;color:${MUTED};margin:0">${UNSUBSCRIBE_MARKER}</p>` +
    `</td></tr></table></td></tr></table></body></html>`;

  const text = blocks
    .map(blockToText)
    .filter((s) => s !== "")
    .join("\n\n");

  return { html, text: `${text}\n\n${UNSUBSCRIBE_MARKER}` };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/shared && bunx vitest run tests/campaign-render.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/campaign-render.ts packages/shared/src/index.ts packages/shared/tests/campaign-render.test.ts
git commit -m "feat(shared): render campaign blocks to table-based email HTML"
```

---

## Task 3: Unsubscribe tokens — `packages/shared/src/api/unsubscribe-token.ts`

**Files:**

- Create: `packages/shared/src/api/unsubscribe-token.ts`, `packages/shared/tests/unsubscribe-token.test.ts`
- Modify: `packages/shared/src/node.ts` (export — this uses `node:crypto` and must **not** reach the browser bundle)

- [ ] **Step 1: Write the failing test**

`packages/shared/tests/unsubscribe-token.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../src/api/unsubscribe-token";

const SECRET = "x".repeat(40);
const CONTACT = "ct_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CAMPAIGN = "cmp_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("unsubscribe tokens", () => {
  it("round-trips", () => {
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    expect(verifyUnsubscribeToken(t, SECRET)).toEqual({
      contactId: CONTACT,
      campaignId: CAMPAIGN,
    });
  });

  it("is URL-safe", () => {
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    expect(t).toBe(encodeURIComponent(t));
  });

  it("refuses a token signed with another secret", () => {
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    expect(verifyUnsubscribeToken(t, "y".repeat(40))).toBeNull();
  });

  it("refuses a token whose contact id was swapped", () => {
    const t = signUnsubscribeToken(CONTACT, CAMPAIGN, SECRET);
    const [, campaignId, sig] = Buffer.from(t, "base64url")
      .toString("utf8")
      .split(".");
    const forged = Buffer.from(
      ["ct_01ARZ3NDEKTSV4RRFFQ69G5FAW", campaignId, sig].join("."),
      "utf8",
    ).toString("base64url");
    expect(verifyUnsubscribeToken(forged, SECRET)).toBeNull();
  });

  it("refuses junk without throwing", () => {
    for (const junk of ["", "....", "not base64!!", "a".repeat(5000)])
      expect(verifyUnsubscribeToken(junk, SECRET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && bunx vitest run tests/unsubscribe-token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write it**

`packages/shared/src/api/unsubscribe-token.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A stateless unsubscribe token: `base64url("<contactId>.<campaignId>.<sig>")`
 * where `sig` is HMAC-SHA256 over `"<contactId>.<campaignId>"` keyed by
 * `APP_SECRET`.
 *
 * Stateless on purpose. A stored token would mean one row per recipient per
 * campaign — 50 000 rows for a 50 000 send, plus a retention story — to buy
 * individual revocation of a link whose only power is to *remove* consent.
 * That is never the dangerous direction.
 *
 * Rotating `APP_SECRET` invalidates every outstanding link. That is already
 * true of every stored AWS and Cloudflare credential, and it is documented on
 * the self-hosting page.
 */

const MAX_TOKEN_CHARS = 512;

function sign(contactId: string, campaignId: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${contactId}.${campaignId}`)
    .digest("base64url");
}

export function signUnsubscribeToken(
  contactId: string,
  campaignId: string,
  secret: string,
): string {
  const sig = sign(contactId, campaignId, secret);
  return Buffer.from(`${contactId}.${campaignId}.${sig}`, "utf8").toString(
    "base64url",
  );
}

export interface UnsubscribeTokenClaims {
  contactId: string;
  campaignId: string;
}

/**
 * Returns the claims, or `null` for anything that is not a valid token. Never
 * throws, and never distinguishes *why* it failed: the caller shows one
 * generic message, so a token cannot be used to probe which ids exist.
 */
export function verifyUnsubscribeToken(
  token: string,
  secret: string,
): UnsubscribeTokenClaims | null {
  if (!token || token.length > MAX_TOKEN_CHARS) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }

  // Exactly three fields: ids contain no dots, so a token with more is either
  // corrupt or an attempt to move the boundary between the signed fields.
  const parts = decoded.split(".");
  if (parts.length !== 3) return null;
  const [contactId, campaignId, sig] = parts as [string, string, string];
  if (!contactId || !campaignId || !sig) return null;

  const expected = Buffer.from(sign(contactId, campaignId, secret), "utf8");
  const actual = Buffer.from(sig, "utf8");
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  return { contactId, campaignId };
}
```

- [ ] **Step 4: Export from `node.ts` only**

Add to `packages/shared/src/node.ts`:

```ts
export {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  type UnsubscribeTokenClaims,
} from "./api/unsubscribe-token";
```

**Do not** add it to `index.ts`. That file is what the browser bundle and the published SDK pull in; a `node:crypto` import there breaks both. `packages/sdk/tests/dist.test.ts` will catch it, but catching it in review is cheaper.

- [ ] **Step 5: Run the tests**

Run: `cd packages/shared && bunx vitest run tests/unsubscribe-token.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/api/unsubscribe-token.ts packages/shared/src/node.ts packages/shared/tests/unsubscribe-token.test.ts
git commit -m "feat(shared): stateless HMAC unsubscribe tokens"
```

---

## Task 4: Schema — `campaigns`, `campaign_recipients`, and two columns on `emails`

**Files:**

- Create: `apps/web/src/db/schema/campaigns.ts`, `apps/web/drizzle/0014_campaigns.sql`
- Modify: `apps/web/src/db/schema/emails.ts`, `apps/web/src/db/schema/index.ts`
- Test: `apps/web/tests/integration/campaigns-schema.test.ts`

**The spec lists `emails.campaign_id` and `contact_id` and they do not exist.** Verify that before writing the migration; if a previous phase added them, adapt rather than duplicating.

- [ ] **Step 1: Write the schema module**

`apps/web/src/db/schema/campaigns.ts`:

```ts
import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { CAMPAIGN_STATUSES, type CampaignBlock } from "@sendsprite/shared";
import { contactBooks, contacts } from "./contacts";
import { domains } from "./domains";
import { emails } from "./emails";
import { organization } from "./auth";

export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    bookId: text("book_id")
      .notNull()
      .references(() => contactBooks.id, { onDelete: "restrict" }),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    from: text("from").notNull(),
    replyTo: text("reply_to"),
    /** The authored block list; the only stored representation of the body. */
    blocks: jsonb("blocks").$type<CampaignBlock[]>().notNull(),
    /**
     * Rendered once when sending starts, then reused for every recipient.
     * Stored so a later edit of `blocks` cannot change what a half-sent
     * campaign puts in the remaining inboxes — the first and last recipient
     * of one campaign must receive the same mail.
     */
    html: text("html"),
    text: text("text"),
    status: text("status", { enum: CAMPAIGN_STATUSES })
      .notNull()
      .default("draft"),
    scheduledAt: timestamp("scheduled_at", {
      withTimezone: true,
      precision: 3,
    }),
    startedAt: timestamp("started_at", { withTimezone: true, precision: 3 }),
    sentAt: timestamp("sent_at", { withTimezone: true, precision: 3 }),
    /**
     * Keyset cursor into the book, so each sweep tick resumes in O(chunk)
     * rather than re-scanning what it already materialised. It is an
     * optimisation, not the correctness mechanism — the unique index on
     * `campaign_recipients` is what actually prevents a double send.
     */
    fanoutCursor: text("fanout_cursor"),
    counts: jsonb("counts")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("campaigns_team_created_idx").on(t.teamId, t.createdAt, t.id),
    // The sweep's only query: campaigns that still owe work.
    index("campaigns_status_idx").on(t.status, t.scheduledAt),
  ],
);

export const CAMPAIGN_RECIPIENT_STATUSES = [
  "pending",
  "queued",
  "skipped",
] as const;
export type CampaignRecipientStatus =
  (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    campaignId: text("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    emailId: text("email_id").references(() => emails.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: CAMPAIGN_RECIPIENT_STATUSES })
      .notNull()
      .default("pending"),
    /** Why a recipient was skipped: `suppressed`, `unsubscribed`, `invalid`. */
    skipReason: text("skip_reason"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The double-send guard. Everything else about the fan-out is an
    // optimisation; this index is the correctness boundary.
    uniqueIndex("campaign_recipients_pk").on(t.campaignId, t.contactId),
    index("campaign_recipients_email_idx").on(t.emailId),
  ],
);

export const campaignRelations = relations(campaigns, ({ many, one }) => ({
  recipients: many(campaignRecipients),
  book: one(contactBooks, {
    fields: [campaigns.bookId],
    references: [contactBooks.id],
  }),
}));
```

Add to `apps/web/src/db/schema/emails.ts`, inside the existing table definition:

```ts
    campaignId: text("campaign_id"),
    contactId: text("contact_id"),
```

**No foreign key on these two, deliberately.** `emails` is the highest-write table in the product and its rows outlive everything: retention purges bodies but keeps rows, and a campaign or contact may be deleted long after. An FK here would either block those deletes or cascade away mail-log history. The join is by id when both sides exist, and a dangling id reads as "the campaign is gone", which is the truth.

Add an index for the campaign stats query, in the same `(t) => [...]` array:

```ts
    index("emails_campaign_idx").on(t.campaignId, t.id),
```

- [ ] **Step 2: Generate and inspect the migration**

Run: `cd apps/web && bunx drizzle-kit generate --name campaigns`

Open the generated `drizzle/0014_campaigns.sql` and check three things before running it:

1. Every `timestamp` is `timestamp(3) with time zone`. **Phase 3 shipped migration `0011` purely to fix a µs/ms mismatch that silently skipped rows in keyset pagination.** A generated `timestamp with time zone` without `(3)` is that bug returning.
2. The unique index on `(campaign_id, contact_id)` is present.
3. `emails.campaign_id` and `contact_id` are plain `text`, with no `REFERENCES` clause.

- [ ] **Step 3: Write the schema test**

`apps/web/tests/integration/campaigns-schema.test.ts`:

```ts
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { startPg, type TestPg } from "./_pg";

let pg: TestPg;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

describe("campaigns schema", () => {
  it("stores every timestamp at millisecond precision", async () => {
    const rows = await pg.db.execute(`
      select table_name, column_name, datetime_precision
      from information_schema.columns
      where table_name in ('campaigns','campaign_recipients')
        and data_type = 'timestamp with time zone'
    `);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows)
      expect(
        r.datetime_precision,
        `${r.table_name}.${r.column_name} must be timestamp(3)`,
      ).toBe(3);
  });

  it("refuses a second recipient row for the same contact", async () => {
    // ... insert a team, book, domain, contact and campaign, then:
    await pg.db.execute(`
      insert into campaign_recipients(campaign_id, contact_id)
      values ('cmp_1','ct_1')
    `);
    await expect(
      pg.db.execute(`
        insert into campaign_recipients(campaign_id, contact_id)
        values ('cmp_1','ct_1')
      `),
    ).rejects.toThrow();
  });
});
```

Fill in the fixture inserts by copying the pattern from `apps/web/tests/integration/contacts.test.ts` — it already creates an org, a book and contacts.

- [ ] **Step 4: Run it**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/campaigns-schema.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/db/schema apps/web/drizzle/0014_campaigns.sql apps/web/tests/integration/campaigns-schema.test.ts
git commit -m "feat(db): campaigns and campaign_recipients"
```

---

## Task 5: Campaign CRUD — `apps/web/src/services/campaigns/crud.ts`

**Files:**

- Create: `apps/web/src/services/campaigns/crud.ts`, `apps/web/tests/integration/campaigns-crud.test.ts`

Follow `apps/web/src/services/templates.ts` exactly for shape: a `Result<T>` return (never a throw for expected failures), a permission check **before** any lookup so a forbidden actor cannot probe which ids exist, and a `recordAudit` row on every mutation with the `<resource>.<verb>` naming Phase 5 committed to (`campaign.created`, `campaign.updated`, `campaign.deleted`, `campaign.scheduled`, `campaign.cancelled`).

- [ ] **Step 1: Write the failing tests**

Cover, at minimum:

```ts
it("refuses to edit a campaign that is sending", async () => {
  /* ... */
});
it("refuses to edit a campaign that has sent", async () => {
  /* ... */
});
it("refuses a book from another team", async () => {
  /* ... */
});
it("refuses a domain that is not verified", async () => {
  /* ... */
});
it("refuses a member without campaigns.manage", async () => {
  /* ... */
});
it("checks the permission before the lookup", async () => {
  /* ... */
});
it("writes an audit row naming the campaign", async () => {
  /* ... */
});
```

The first two are the load-bearing ones. **A campaign in `sending` or `sent` is immutable.** Editing the blocks of a half-sent campaign would mean the first 10 000 recipients got one mail and the rest got another, under one name, with one set of stats — an incoherence a customer cannot untangle afterwards. `draft` and `scheduled` are editable; `scheduled` reverts to `draft` on edit so nobody accidentally ships an unreviewed change on a timer.

- [ ] **Step 2: Implement**

Key signatures the rest of the plan depends on — keep these names exactly:

```ts
export interface CampaignActor {
  userId: string;
  teamId: string;
  role: TeamRole;
  meta: RequestMeta;
}

export async function listCampaignsPage(
  teamId: string,
  query: { limit?: number; cursor?: string; status?: CampaignStatus },
): Promise<Result<{ data: CampaignObject[]; nextCursor: string | null }>>;

export async function getCampaign(
  teamId: string,
  id: string,
): Promise<CampaignRow | null>;

export async function createCampaign(
  actor: CampaignActor,
  raw: unknown,
): Promise<Result<CampaignObject>>;

export async function updateCampaign(
  actor: CampaignActor,
  id: string,
  raw: unknown,
): Promise<Result<CampaignObject>>;

export async function deleteCampaign(
  actor: CampaignActor,
  id: string,
): Promise<Result<void>>;
```

**Amendment after Task 4 shipped as `08224bc`.** `campaigns.book_id` and `domain_id` carry **no foreign key** — this schema has no `restrict` FK anywhere (26 cascade, 4 set null), and `deleteBook`/`deleteDomain` delete unconditionally without catching a violation, so `restrict` would have surfaced as an unhandled 500 on a Phase 6 screen. `set null` is unavailable because `CampaignObject` types both ids as non-nullable. **Consequence you must honour: list and detail queries have to LEFT JOIN book and domain and render the missing side, and create/update must check both exist and belong to the caller's team.** A campaign whose book was deleted must not crash the list.

**The domain check matters.** A campaign names a `domainId`; sending from an unverified domain fails at SES for every recipient. Check verification at create/update _and_ again when sending starts (a domain can be deleted or fail re-verification in between) — the same two-times-for-two-moments reasoning as the suppression check.

- [ ] **Step 3: Run, then commit**

```bash
cd apps/web && bunx vitest run --project integration tests/integration/campaigns-crud.test.ts
git add apps/web/src/services/campaigns/crud.ts apps/web/tests/integration/campaigns-crud.test.ts
git commit -m "feat(campaigns): CRUD with an immutable sending state"
```

---

## Task 6: Audience selection — `apps/web/src/services/campaigns/audience.ts`

This is Decision 3 in code: **the one place consent and deliverability legitimately meet.**

**Files:**

- Create: `apps/web/src/services/campaigns/audience.ts`, `apps/web/tests/integration/campaign-audience.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("counts a subscribed, unsuppressed contact as eligible", async () => {});
it("excludes an unsubscribed contact", async () => {});
it("excludes a suppressed contact even though it is subscribed", async () => {});
it("matches suppression case-insensitively", async () => {});
it("counts a contact suppressed AND unsubscribed once, not twice", async () => {});
it("selects in a stable order so the cursor cannot skip a contact", async () => {});
```

The case-insensitivity test is not cosmetic: `contacts.email` carries a check constraint forcing `lower(btrim(email))`, but `suppressions.email` came from SES events and API callers. If the join is `contacts.email = suppressions.email` and a suppression was stored with any uppercase, **the suppressed address gets mailed.** Assert it directly.

The "once, not twice" test guards the audience preview: a contact who is both unsubscribed and suppressed must not make `subscribed + suppressed + eligible` exceed `contacts`, or the card shows arithmetic that does not add up.

- [ ] **Step 2: Implement**

```ts
/**
 * Eligible = subscribed (consent) AND not suppressed (deliverability).
 *
 * Both, not either. Phase 6 kept these two lists apart on purpose — leaving a
 * newsletter must not stop a password reset, and a hard bounce is not a
 * withdrawal of consent. Campaign selection is the single read-time join where
 * both apply, because a campaign is exactly the kind of mail consent governs
 * and exactly the kind of volume that damages a sending reputation.
 *
 * The suppression join is on `lower(suppressions.email)`: contacts are stored
 * lower-cased by a check constraint, suppressions are not, and a case
 * mismatch here would mail a suppressed address.
 */
export async function selectEligible(
  teamId: string,
  bookId: string,
  opts: { afterContactId?: string | null; limit: number },
): Promise<
  {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  }[]
>;

export async function audiencePreview(
  teamId: string,
  bookId: string,
): Promise<AudiencePreview>;
```

Order by `contacts.id` ascending — ULIDs, so it is insertion order and stable. A contact added _during_ a send sorts after the cursor and is picked up by a later tick; a contact added before the cursor is missed. Document that: **a campaign's audience is not frozen at start, and that is a known limitation** (Phase 8 opener).

- [ ] **Step 3: Run, then commit**

```bash
cd apps/web && bunx vitest run --project integration tests/integration/campaign-audience.test.ts
git add apps/web/src/services/campaigns/audience.ts apps/web/tests/integration/campaign-audience.test.ts
git commit -m "feat(campaigns): audience selection joining consent and suppression"
```

---

## Task 7: The fan-out — `apps/web/src/services/campaigns/fanout.ts`

One bounded chunk per call. Resumable, idempotent, and the only thing that creates campaign email rows.

**Files:**

- Create: `apps/web/src/services/campaigns/fanout.ts`, `apps/web/tests/integration/campaign-fanout.test.ts`

- [ ] **Step 1: Write the failing tests**

These are the tests that matter most in the phase:

```ts
it("materialises one chunk and advances the cursor", async () => {});
it("running the same chunk twice sends nothing twice", async () => {});
it("finishes: the last chunk marks the campaign sent", async () => {});
it("substitutes a different unsubscribe link per recipient", async () => {});
it("puts List-Unsubscribe and List-Unsubscribe-Post on every row", async () => {});
it("records a skipped recipient with a reason instead of an email row", async () => {});
it("renders once — every recipient gets byte-identical body HTML apart from the unsubscribe link", async () => {});
it("does not enqueue a send for a row it did not insert", async () => {});
```

The second and last are the double-send guards. Write the second one as: run `fanoutChunk` twice against the same campaign with no state reset, then assert `select count(*) from emails where campaign_id = ...` equals the recipient count, **not** twice it.

- [ ] **Step 2: Implement**

```ts
export const CHUNK = 500;

export interface FanoutResult {
  materialised: number;
  skipped: number;
  done: boolean;
}

/**
 * Materialise at most `CHUNK` recipients for one campaign and return.
 *
 * **This function never enqueues itself.** A handler on an exclusive queue
 * that re-enqueues itself has silently stalled this codebase twice; the
 * continuation is `campaign.fan-out-sweep`, on a cron, one chunk per tick.
 *
 * Idempotency is the unique index on `(campaign_id, contact_id)`, not the
 * cursor: the insert is `on conflict do nothing` with `.returning()`, and only
 * rows that came back — rows this call actually inserted — get an `email.send`
 * job. A crash between the insert and the enqueue is recovered by
 * `email.queued-sweep`, which already re-enqueues due `queued` rows whose job
 * was lost.
 */
export async function fanoutChunk(
  campaignId: string,
  deps: { enqueue: Enqueue; now?: Date },
): Promise<FanoutResult>;
```

**Race recorded by Task 4:** deleting a contact mid-send cascades away its `campaign_recipients` row, so a contact deleted and then re-imported (new ULID) can be picked up again by a still-`sending` campaign and mailed twice. `restrict` would close it at the cost of 500-ing contact deletion, which is worse. Note it in the Phase 8 openers rather than fixing it here.

Per chunk, in order:

1. Load the campaign. If its status is not `sending`, return `{ done: true }` — a cancel between ticks must stop the fan-out.
2. `selectEligible(teamId, bookId, { afterContactId: campaign.fanoutCursor, limit: CHUNK })`.
3. If empty: set `status = "sent"`, `sentAt = now`, refresh counts, return `{ done: true }`.
4. For each contact, build the row: `subject` from the campaign, `html`/`text` from the campaign's **stored** render with `UNSUBSCRIBE_MARKER` replaced by that recipient's footer, `source: "campaign"`, `campaignId`, `contactId`, and the header pair below.
5. Insert the `emails` rows and the `campaign_recipients` rows in **one transaction**, `on conflict do nothing`, `.returning()`.
6. Advance `fanoutCursor` to the last contact id in the chunk.
7. Enqueue `email.send` for each returned row.

The header pair, per recipient:

```ts
const url = `${appUrl}/unsubscribe/${signUnsubscribeToken(contact.id, campaign.id, secret)}`;
const headers = {
  "List-Unsubscribe": `<${url}>`,
  // RFC 8058. Without this, Gmail and Outlook show no native unsubscribe
  // button and the recipient's only route out is the spam button — which
  // costs far more reputation than an unsubscribe does.
  "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
};
```

And the footer substitution:

```ts
const footer = `<a href="${escapeHtml(url)}">Unsubscribe</a>`;
const html = campaign.html!.replaceAll(UNSUBSCRIBE_MARKER, footer);
const text = campaign.text!.replaceAll(
  UNSUBSCRIBE_MARKER,
  `Unsubscribe: ${url}`,
);
```

**Use `replaceAll` with a string, not a regex**, and note why in a comment: `String.replace` with a string replaces only the first occurrence, and a `$` in a generated URL is a substitution pattern in the replacement string. The marker contains no `$`, but the URL is the _replacement_ — pass it through a function form (`() => footer`) if any doubt remains.

- [ ] **Step 3: Run, then commit**

```bash
cd apps/web && bunx vitest run --project integration tests/integration/campaign-fanout.test.ts
git add apps/web/src/services/campaigns/fanout.ts apps/web/tests/integration/campaign-fanout.test.ts
git commit -m "feat(campaigns): resumable chunked fan-out"
```

---

## Task 8: The sweeps — `apps/web/src/jobs/handlers/campaign-fanout.ts`

**Files:**

- Create: `apps/web/src/jobs/handlers/campaign-fanout.ts`
- Modify: `apps/web/src/jobs/queues.ts`, `apps/web/src/jobs/handlers/index.ts`
- Test: `apps/web/tests/integration/campaign-loop.test.ts`

- [ ] **Step 1: Add the queue names**

In `apps/web/src/jobs/queues.ts`, following the existing `<domain>.<verb>` convention:

```ts
  campaignStartSweep: "campaign.start-sweep",
  campaignFanoutSweep: "campaign.fan-out-sweep",
```

- [ ] **Step 2: Write the handlers**

```ts
/**
 * Flips `scheduled` campaigns whose time has come to `sending`: renders the
 * body once, stores it, re-checks the domain, and lets the fan-out sweep take
 * over. Every minute.
 */
registerQueue(Q.campaignStartSweep, () => startDueCampaigns({ enqueue }), {
  cron: "* * * * *",
  // retryLimit 0: a failed tick is simply retried by the next one, and
  // starting is idempotent (the status flip is a conditional update).
  queue: { retryLimit: 0 },
});

/**
 * Advances every campaign in `sending` by one chunk. Every minute.
 *
 * One chunk per campaign per tick, deliberately: a 50 000-recipient campaign
 * takes 100 ticks at CHUNK=500 rather than monopolising the worker, and a
 * second campaign starting mid-way still makes progress on the next tick.
 * Throughput is governed by the SES token bucket downstream, not here.
 */
registerQueue(Q.campaignFanoutSweep, () => sweepSendingCampaigns({ enqueue }), {
  cron: "* * * * *",
  queue: { retryLimit: 0 },
});
```

**Neither handler enqueues itself.** If a later change makes one want to, that is the signal to raise `CHUNK`, not to recurse.

`sweepSendingCampaigns` must bound its own work too: take at most N campaigns per tick (`N = 10`), oldest `startedAt` first, so one enormous campaign cannot starve the others and a tick has a predictable ceiling.

- [ ] **Step 3: Write the loop test**

`apps/web/tests/integration/campaign-loop.test.ts` — model it on `domain-loop.test.ts`, and note that file's lesson: it polls with a **60-second** deadline because a 30-second one was under a second from failing on CI. Give the loop room.

```ts
it("drives a campaign from scheduled to sent across ticks", async () => {});
it("a cancel between ticks stops the fan-out", async () => {});
it("does not start a campaign whose domain stopped being verified", async () => {});
```

- [ ] **Step 4: Register, run and commit**

Add the import to `apps/web/src/jobs/handlers/index.ts`.

**Note for whoever touches that file:** it imports every handler, and Phase 6 found that one handler module throwing at import time takes out the whole worker (recorded as Phase 7 opener 19). Do not add module-scope work to your new handler beyond `registerQueue`.

```bash
cd apps/web && bunx vitest run --project integration tests/integration/campaign-loop.test.ts
git add apps/web/src/jobs apps/web/tests/integration/campaign-loop.test.ts
git commit -m "feat(campaigns): schedule and fan-out sweeps"
```

---

## Task 9: Stats and `campaign.*` webhooks

**Files:**

- Create: `apps/web/src/services/campaigns/stats.ts`
- Modify: `apps/web/src/services/ingest.ts` (campaign counters), `packages/shared/src/api/webhooks.ts` (event types)
- Test: `apps/web/tests/integration/campaign-stats.test.ts`

- [ ] **Step 1: Derive the counts**

```ts
/**
 * Counts derived from `emails` and `email_events`, never incremented.
 *
 * An incremented counter drifts the first time a webhook retries or a worker
 * dies mid-update, and a stats page that disagrees with the mail log is worse
 * than one that takes an extra second. `campaigns.counts` is a cache of this
 * function's result, refreshed by the sweep; the campaign page recomputes live
 * while a campaign is still sending.
 */
export async function campaignCounts(
  teamId: string,
  campaignId: string,
): Promise<CampaignCounts>;
```

One grouped query over `emails` joined to its latest event per row. Reuse whatever `services/stats.ts` already does for the overview rather than inventing a second aggregation shape — read it first.

- [ ] **Step 2: Fire the two campaign events**

The webhook events table has promised `campaign.sent` and `campaign.completed` since Phase 3. Phase 6 un-reserved `contact.*` and found the table was lying in two ways; check this one against the code before documenting it.

- `campaign.sent` — fires **once**, when the last chunk materialises and the campaign flips to `sent`. It means "every recipient has been queued", not "every recipient has received it".
- `campaign.completed` — fires when every queued email has reached a terminal state (`delivered`, `bounced`, `failed`). This is the one a customer waits on before reading stats.

Both carry `{ campaign: publicCampaign(row) }`, wrapped under a key — matching `data.email`, `data.domain` and `data.contact`. Phase 6 changed the contact payload precisely because it was the odd one out; do not reintroduce the inconsistency.

**Name the distinction in the docs page.** "Sent" meaning "queued" is exactly the sort of thing that generates a support thread when a customer's automation treats it as "delivered".

- [ ] **Step 3: Run and commit**

```bash
cd apps/web && bunx vitest run --project integration tests/integration/campaign-stats.test.ts
git add apps/web/src/services/campaigns/stats.ts apps/web/src/services/ingest.ts packages/shared/src/api/webhooks.ts apps/web/tests/integration/campaign-stats.test.ts
git commit -m "feat(campaigns): derived stats and campaign.* webhooks"
```

---

## Task 10: Unsubscribe — the public page and the one-click POST

The highest-risk surface in the phase: unauthenticated, cross-origin, and hit by machines.

**Files:**

- Create: `apps/web/src/services/unsubscribe.ts`, `apps/web/src/app/(unsubscribe)/unsubscribe/[token]/page.tsx`, `.../actions.ts`, `apps/web/src/app/api/unsubscribe/[token]/route.ts`
- Test: `apps/web/tests/integration/unsubscribe.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("GET does not unsubscribe — it only renders the confirmation", async () => {});
it("POST unsubscribes and is idempotent", async () => {});
it("a token signed with another secret changes nothing", async () => {});
it("an invalid token and an unknown contact give the same generic message", async () => {});
it("unsubscribing writes no suppression row", async () => {});
it("records the reason as the campaign it came from", async () => {});
```

The first is the one that protects real recipients. Write it as: `GET` the page, then assert `contacts.subscribed` is still `true`.

The fifth enforces Phase 6 Decision 3 across a new surface: leaving a newsletter must not stop that person's password resets. Assert `select count(*) from suppressions` is unchanged.

- [ ] **Step 2: Implement**

```tsx
/**
 * GET renders a page with a button and changes nothing.
 *
 * Corporate mail security products (Defender, Proofpoint, Mimecast) follow
 * every link in an incoming message to inspect it. If GET unsubscribed, a
 * scanner would silently unsubscribe recipients who never touched the mail,
 * and the first symptom would be a customer asking why their list is
 * evaporating. This is not hypothetical; it is the standard failure of
 * one-click unsubscribe implementations.
 */
export default async function UnsubscribePage({ params }: { ... }) { ... }
```

And the route that RFC 8058 clients POST to:

```ts
/**
 * `POST /api/unsubscribe/:token` — the RFC 8058 one-click endpoint named by
 * `List-Unsubscribe-Post`.
 *
 * Deliberately NOT CSRF-protected, and deliberately unauthenticated: the spec
 * requires a cross-origin POST from a mail client with no session and no
 * origin we can predict. The HMAC token *is* the authorisation, and the only
 * action it authorises is removing consent. A forged request achieves what the
 * recipient could achieve by clicking the link themselves.
 *
 * Always 200, even for a bad token: a mail client showing an error teaches the
 * recipient to press the spam button instead, which costs the sender far more.
 */
export async function POST(...) { ... }
```

**Never log the token.** It is the authorisation, so a token in an access log, an error report or a Sentry breadcrumb is a working unsubscribe link for that recipient sitting in a system with much wider read access than the mailbox it came from. Log the outcome, never the credential. (Carried from Task 3, which found the verifier had three other ways to go wrong.)

**Rate-limit the POST by IP** using the existing token-bucket pattern, and say why in a comment: the token is unguessable, so this is not brute-force protection — it is protection against one broken client retrying a loop against the database.

- [ ] **Step 3: Run and commit**

```bash
cd apps/web && bunx vitest run --project integration tests/integration/unsubscribe.test.ts
git add apps/web/src/services/unsubscribe.ts "apps/web/src/app/(unsubscribe)" apps/web/src/app/api/unsubscribe apps/web/tests/integration/unsubscribe.test.ts
git commit -m "feat(campaigns): public unsubscribe page and RFC 8058 one-click"
```

---

## Task 11: REST — `/api/v1/campaigns`

**Files:**

- Create: `apps/web/src/app/api/v1/campaigns/route.ts`, `.../[id]/route.ts`, `.../[id]/schedule/route.ts`, `.../[id]/cancel/route.ts`, `.../[id]/audience/route.ts`
- Test: `apps/web/tests/integration/campaigns-api.test.ts`

Copy the envelope, error codes and auth wiring from `apps/web/src/app/api/v1/templates/**` — do not invent a new shape.

| Method   | Path                      | Notes                                          |
| -------- | ------------------------- | ---------------------------------------------- |
| `GET`    | `/campaigns`              | keyset page, optional `status` filter          |
| `POST`   | `/campaigns`              | `CreateCampaignInput` → 201                    |
| `GET`    | `/campaigns/:id`          |                                                |
| `PATCH`  | `/campaigns/:id`          | refused unless `draft`/`scheduled`             |
| `DELETE` | `/campaigns/:id`          | refused while `sending`                        |
| `POST`   | `/campaigns/:id/schedule` | `ScheduleCampaignInput`; no body = start now   |
| `POST`   | `/campaigns/:id/cancel`   | `scheduled` → `draft`; `sending` → `cancelled` |
| `GET`    | `/campaigns/:id/audience` | `AudiencePreview`                              |

**`sending_only` API keys must be refused on all of these.** A key scoped to sending transactional mail must not be able to mail a customer's entire list — that is a much larger blast radius than the scope implies. Assert it in a test.

`openapi-coverage.test.ts` fails **both ways** — an undocumented route and a documented non-route — so the OpenAPI additions are not optional.

- [ ] **Step 1: Write the failing tests** — one per row above, plus:

```ts
it("refuses a sending_only key on every campaign route", async () => {});
it("cancel on a sending campaign stops further fan-out", async () => {});
it("schedule refuses a time in the past", async () => {});
```

- [ ] **Step 2: Implement, run, commit**

```bash
cd apps/web && bunx vitest run --project integration tests/integration/campaigns-api.test.ts
git add apps/web/src/app/api/v1/campaigns apps/web/tests/integration/campaigns-api.test.ts
git commit -m "feat(api): campaigns REST surface"
```

---

## Task 12: SDK — the `campaigns` namespace

**Files:**

- Create: `packages/sdk/src/resources/campaigns.ts`
- Modify: `packages/sdk/src/client.ts`, `packages/sdk/src/types.ts`, `packages/sdk/tests/types-parity.test.ts`, `packages/sdk/tests/resources.test.ts`

Follow `packages/sdk/src/resources/templates.ts`. Three things this package enforces that are easy to trip:

1. **Public types are hand-written**, then pinned to the shared contract by the compile-time `Mutual<A,B>` tuple in `types-parity.test.ts`. That tuple is checked by `tsc`, not vitest — a mismatch is a typecheck failure, not a test failure. Phase 6 took it from 35 to 57 entries; add the campaign types to it.
2. **`dist.test.ts` forbids** any `@sendsprite/shared`, `zod` or `react` specifier in the published `.d.ts` and `.js`. tsup inlines them via `noExternal`; if a specifier leaks, the fix is the build config, never an exception in the test.
3. `packages/shared/src/api/unsubscribe-token.ts` imports `node:crypto` and is exported only from `node.ts`. **Nothing in the SDK may import it.**

- [ ] **Steps:** write the namespace, add the parity entries, run `bun run typecheck` (this is where a parity mismatch surfaces), run `bunx vitest run tests/dist.test.ts` against a fresh `tsup` build, commit.

```bash
git add packages/sdk
git commit -m "feat(sdk): campaigns namespace"
```

---

## Task 13: Dashboard — the campaign list and the block editor

**Files:**

- Create: `apps/web/src/app/app/campaigns/page.tsx`, `CampaignList.tsx`, `actions.ts`, `new/page.tsx`, `[id]/page.tsx`, `[id]/CampaignEditor.tsx`, `[id]/blocks/*.tsx`, `apps/web/src/app/app/campaigns/preview.ts`
- Modify: `apps/web/package.json` (Tiptap + dnd-kit)
- Test: `apps/web/tests/unit/campaign-preview.test.ts`

Read `apps/web/src/app/app/templates/[slug]/TemplateEditor.tsx` (commit `fa344be`) before starting. It is the closest existing surface and it solved several of these problems already: the dirty-state badge diffed against the last committed snapshot, the `beforeunload` guard, the read-only branch that changes the copy rather than leaving dead controls, and the sandboxed preview iframe.

**Dependencies.** Add `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `@dnd-kit/core`, `@dnd-kit/sortable`. Configure Tiptap per Decision 7: **no node types beyond paragraph, marks limited to bold, italic and link.** Disable the StarterKit nodes you are not using explicitly rather than relying on defaults — a Tiptap minor upgrade that adds a node type must not silently widen what a campaign can contain.

If Tiptap resists this constraint, **stop and report.** A textarea with a documented inline-markup subset is a better outcome than an editor that can emit anything.

**The preview must be a sandboxed iframe** (`<iframe sandbox="" srcDoc={html} />`), exactly as `EmailDetail.tsx` and the template preview do. The block contract refuses `javascript:` URLs, so this is defence in depth rather than the only guard — but the preview renders customer-authored content inside a dashboard session, and one bug in the URL check should not become account takeover.

**The preview must call `renderBlocks` from `@sendsprite/shared`** — the same function the send calls. Do not write a React preview renderer; that is how a preview starts disagreeing with what recipients receive.

- [ ] **Step 1: Extract the testable logic first**

There is no React test environment in this repo, so anything worth asserting must live outside the component. Put it in `preview.ts`: block reordering, the "add block" defaults, and the preview assembly. Unit-test that.

- [ ] **Step 2: Build the list page** — name, status badge, book, recipients, sent date, and a Delete that is refused while sending. Empty state explains what a campaign is and links to `/app/contacts` if the team has no book yet: a campaign with no audience is the most likely first-run dead end.

- [ ] **Step 3: Build the editor** — block list with dnd-kit ordering, per-block forms, add/remove, live sandboxed preview, and the subject/from/reply-to fields. Read-only for a member without `campaigns.manage`; **fully read-only for everyone once the campaign is `sending` or `sent`**, with copy saying why.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/app/campaigns apps/web/package.json bun.lock apps/web/tests/unit/campaign-preview.test.ts
git commit -m "feat(web): campaign block editor with a live preview"
```

---

## Task 14: Dashboard — audience, schedule, send and stats

**Files:**

- Create: `apps/web/src/app/app/campaigns/[id]/AudienceCard.tsx`, `SendCard.tsx`, `StatsPanel.tsx`
- Modify: `apps/web/src/app/app/campaigns/[id]/page.tsx`, `actions.ts`

This is the screen where somebody irreversibly mails thousands of people. Design it accordingly.

- [ ] **Step 1: The audience card** shows the four numbers from `AudiencePreview` — contacts, subscribed, suppressed, eligible — and explains the difference in one line, because a customer seeing "1 000 contacts, 940 eligible" will otherwise open a support ticket asking where 60 people went.

- [ ] **Step 2: The send confirmation must state the number and be typed to confirm.** Not a bare "Are you sure?" — a dialog that names the campaign, the book, and **the exact recipient count**, and requires typing the campaign name to enable the button. Sending is not undoable once the first chunk is queued; the friction is the feature.

- [ ] **Step 3: Cancel is honest about what it can and cannot do.** Cancelling a `sending` campaign stops _further_ fan-out; it cannot recall mail already handed to SES. The dialog must say so, and the stats panel must keep showing the recipients who were already sent to. A cancel that implied recall would be a lie a customer discovers from their recipients.

- [ ] **Step 4: The stats panel** shows the derived counts with a live refresh while `sending`, and links each number to the mail log filtered by that campaign — `emails_campaign_idx` exists for exactly this query.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/app/campaigns
git commit -m "feat(web): campaign audience, send confirmation and stats"
```

---

## Task 15: End-to-end

**Files:**

- Create: `apps/web/tests/e2e/campaigns.spec.ts`

Runs against the **pre-built** server (`apps/web/scripts/e2e-server.ts`), not `next dev` — three separate rounds of e2e timeouts in earlier phases traced back to `next dev` compiling routes mid-test.

One path, end to end, through the real server:

1. Create a contact book with three contacts; suppress one; unsubscribe another.
2. Create a campaign in the editor: heading, text with a bold run and a link, button, image.
3. Assert the preview iframe renders the rendered HTML.
4. Open the audience card and assert **eligible is 1**, with the suppressed and unsubscribed contacts accounted for.
5. Send, typing the name to confirm.
6. Assert exactly one email row exists for the campaign, and that its recipient is the eligible contact.
7. Open the mail log entry and assert the body contains an `Unsubscribe` link and that `List-Unsubscribe` is on the row.
8. Follow the unsubscribe URL with a **GET** and assert the contact is _still subscribed_ — then POST and assert they are not.

Step 8 is the one that would catch the link-scanner bug in a way no unit test can, because it exercises the real route.

```bash
cd apps/web && bun run test:e2e
git add apps/web/tests/e2e/campaigns.spec.ts
git commit -m "test(e2e): campaign send with consent and one-click unsubscribe"
```

---

## Task 16: Docs, README, changeset, status block and the tag

- [ ] **Step 1: `/docs/campaigns`** — blocks and what each renders to, the audience rule (**subscribed AND not suppressed**, with the reasoning), scheduling, what cancel can and cannot do, and the `campaign.sent` vs `campaign.completed` distinction spelled out: **"sent" means every recipient was queued, not that anyone received it.**

- [ ] **Step 2: `/docs/unsubscribe`** — the token model, that `APP_SECRET` rotation invalidates outstanding links, the GET/POST split and why, and `List-Unsubscribe` for customers running their own unsubscribe pages.

- [ ] **Step 3: Un-reserve `campaign.*` in the webhooks table** — and verify against the code which events actually fire, the way Phase 6 did for `contact.*`. Phase 6 found that table lying in two separate ways; assume nothing.

- [ ] **Step 4: README** — remove any stale phase claim about campaigns.

- [ ] **Step 5: Changeset** — user-visible behaviour, written for someone upgrading a package. Name the new `campaigns` SDK namespace, the REST surface, and the unsubscribe endpoints.

- [ ] **Step 6: Full gate**

```
bun run typecheck && bun run lint && bun run format && bun run test
bun run test:integration
bun run test:e2e
```

Record exact counts. Baseline entering Phase 7 (`c6b39b4`): **680 unit, 372 integration, 17 e2e.**

- [ ] **Step 7: Status block and tag**

Append `## Phase 7 status: COMPLETE` in the shape Phases 5 and 6 used — per-task commits, gate counts, deviations and why — then a **Phase 8 openers** list seeded with:

1. **The audit-log UI and the analytics overview**, deferred from this phase by decision. The audit rows are already being written.
2. **A campaign's audience is not frozen at start.** Selection is a keyset walk by contact id, so a contact added mid-send after the cursor is included and one added before it is not. Freezing the audience at start (materialising all recipient rows up front) is the fix, at the cost of one large write.
3. **No test send.** There is no "send this to me first", which is the single most requested campaign feature and the cheapest insurance against mailing 50 000 people a broken layout.
4. **Cancel cannot recall queued mail.** Rows already handed to `email.send` go out. Draining the queue for a cancelled campaign — marking its `queued` rows `cancelled` before SES claims them — would recover most of a mistake caught quickly.
5. **No per-campaign send-rate control.** Throughput is whatever the SES token bucket allows, so a large campaign can crowd out transactional mail for minutes. A per-campaign rate ceiling, or a lower queue priority for `source: "campaign"`, would protect the mail that a customer's users are actively waiting for. **This is the one on this list most likely to generate a support incident.**
6. **`campaigns.counts` is refreshed by the sweep, so a finished campaign's cache stops updating** when late events (opens, clicks) arrive days later. The page recomputes live, so only the list view can look stale.
7. **No URL-scheme filter outside campaign blocks.** Task 1 added `SafeUrl` for blocks, which closes Phase 6 opener 4 _for campaigns only_ — a `javascript:` URL interpolated into a template variable is still refused by nothing but the sandboxed preview.

```bash
git add docs README.md .changeset apps/web packages
git commit -m "docs: Phase 7 status and the Phase 8 openers"
git tag phase-7-complete
```

---

## Self-review

**1. Spec coverage.** Every clause of §5's `campaigns`/`campaign_recipients` and §10's `/app/campaigns` maps to a task:

| Spec                                       | Task   |
| ------------------------------------------ | ------ |
| `campaigns` table (all columns)            | 4      |
| `campaign_recipients`                      | 4      |
| block editor, audience, schedule, stats    | 13, 14 |
| email-safe table-based HTML                | 2      |
| `campaign.sent`/`completed` webhooks       | 9      |
| `/unsubscribe/:token`                      | 10     |
| `emails.campaign_id`/`contact_id`/`source` | 4, 7   |
| REST + SDK                                 | 11, 12 |

**Gap found and closed while reviewing:** the spec's `counts` column implied incremented counters; Decision 8 makes it a cache of a derived query, and Task 9 states that explicitly. **Second gap:** the spec never mentions `List-Unsubscribe`, which bulk mail cannot ship without — Tasks 7 and 10 add it.

**2. Placeholder scan.** Tasks 1–4, 7 and 10 carry complete code for every logic-bearing module. Tasks 5, 6, 9, 11–14 carry signatures, the tests that must pass, and the constraints, with the reasoning that makes them checkable — this is the deliberate split described in "How to read this plan", not an omission.

**3. Type consistency.** `renderBlocks(blocks) → { html, text }` is called by Tasks 7, 13 and 14 with that exact shape. `UNSUBSCRIBE_MARKER` is defined in Task 2 and consumed in Task 7. `signUnsubscribeToken(contactId, campaignId, secret)` is defined in Task 3 and called in Tasks 7 and 10 with that argument order. `fanoutChunk(campaignId, deps)` is defined in Task 7 and called in Task 8. `AudiencePreview`'s four fields are identical in Tasks 1, 6, 11 and 14. `CampaignCounts`'s nine fields are identical in Tasks 1, 9 and 14.
