# Phase 6 — Templates and Contacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `template` on `POST /emails` actually work, and ship the two resources behind it — versioned **templates** with a `{{variable}}` render path, and **contacts** in books with CSV import, subscription status and unsubscribe — across REST, SDK, CLI, MCP and the dashboard.

**Architecture:** One renderer, in one place. `renderTemplate()` lives in `@sendsprite/shared` as a pure function with no dependencies, so the send path, `POST /templates/:slug/render` and the dashboard's live preview all produce byte-identical output — a preview that lies is worse than no preview. Escaping is a property of the **field**, not of the caller: `body_html` HTML-escapes every substituted value, `body_text` does not, and the rendered `subject` is re-checked for CR/LF because a header injection cannot be escaped away. There is no raw/unescaped placeholder form at all. Contacts are consent, suppressions are deliverability: two tables, two REST surfaces, two mental models, and nothing in this phase writes one from the other.

**Tech Stack:** Bun 1.3 workspaces, TypeScript 5.9, zod 4, Next 16 (App Router, server actions), Drizzle 0.45 + drizzle-kit 0.31 on Postgres, pg-boss 12, Vitest 4 (+ embedded-postgres for integration), Playwright. **No new runtime dependency is added by this phase** — the CSV parser and the template renderer are both hand-written, for the reasons below.

---

## Decisions already made (recorded, not up for relitigation)

### 1. The templating syntax is `{{ name }}` and nothing else

| Rule             | Decision                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Delimiters       | `{{ name }}`. Whitespace inside the braces is ignored. Anything not matching the placeholder pattern is literal text.           |
| Names            | `[A-Za-z_][A-Za-z0-9_]*`, dotted for nesting (`user.firstName`), 64 chars per segment, 4 segments deep.                         |
| Expressions      | **None.** No helpers, filters, partials, conditionals, loops, arithmetic or comparisons.                                        |
| Raw / unescaped  | **None.** No `{{{ }}}`, no `\| safe`, no opt-out. A caller who needs per-recipient HTML sends `html` directly.                  |
| Recursion        | **None.** One pass over the source; substituted text is never re-scanned, so `{{a}}` where `a = "{{b}}"` emits literal `{{b}}`. |
| Missing value    | **A refusal, not an empty string.** `validation_error` naming every missing placeholder.                                        |
| Non-scalar value | **A refusal.** Objects, arrays and functions are rejected rather than rendered as `[object Object]`.                            |

**Why hand-written and not Handlebars/liquid.** A template engine's value is its expression language, and its expression language is the attack surface: prototype pollution through `constructor.prototype`, helper injection, and — with liquid — a sandbox that must be configured rather than absent. This phase renders third-party data into HTML that is then emailed, on a self-hosted server the operator may not be watching. A ~90-line function with no expression language has no sandbox to get wrong, adds nothing to the SDK's bundle, and runs unchanged in the browser for the live preview. The cost is real and accepted: no loops means no per-recipient item lists, which is what campaigns (Phase 7) and `sendsprite/react` are for.

**Why strict on missing variables.** A silent empty string produces "Hi ," at volume and nobody notices until a customer forwards a screenshot. `variables_schema` exists precisely so an optional variable can be _declared_ with a `default` — that is the supported way to make a placeholder optional, and it is visible in the editor.

### 2. Escaping is decided by the field, not by the author

`renderTemplate` takes the three fields together and applies a different rule to each:

- **`bodyHtml`** — every substituted value goes through `escapeHtml` (`& < > " '`). The template body itself is trusted (a team member wrote it); the _values_ are not.
- **`bodyText`** — no escaping. It is not HTML; escaping it would put `&amp;` in a plain-text mail.
- **`subject`** — no HTML escaping (a subject is a MIME header, not markup), but the **rendered** result is re-checked: CR/LF anywhere is a refusal, and the 1–998 character bound is re-applied. `SendEmailInput` rejects CR/LF in a client-supplied subject; a rendered subject bypasses that check by construction, so the check is repeated on the output. **This is the header-injection guard and it is not optional.**

Three known limits, written down rather than papered over:

1. **HTML escaping does not make a URL safe.** `<a href="{{link}}">` with `link = "javascript:…"` survives escaping. Mail clients do not execute `javascript:` hrefs, and every preview surface in this repo renders inside `<iframe sandbox="">` (no scripts, no navigation) — see `EmailDetail.tsx`. A URL-context scheme filter is recorded as an opener, not built here.
2. **Escaping is not sanitising.** A team member who writes `<script>` into `body_html` gets `<script>` in the mail. That is the same trust boundary `POST /emails` already has for `html`, and it is correct: the template body is authored by the team, like the email body.
3. **CSS and attribute contexts.** `style="color:{{c}}"` is escaped as HTML, which stops attribute-breaking but not CSS expressions. Templates are authored, not user-generated; the guard that matters is on the values.

### 3. Unsubscribe is consent; suppression is deliverability. They stay apart.

|                | `suppressions`                                                | `contacts.subscribed`                                                    |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Scope          | `(team_id, email)` — the whole team                           | `(book_id, email)` — one book                                            |
| Means          | "This address must not be sent to"                            | "This person does not want _this kind of_ mail"                          |
| Written by     | SES bounce/complaint events; `POST /suppressions`             | `POST /contacts/unsubscribe`; the dashboard; CSV import                  |
| Enforced where | `createEmail` — blocks **every** send, transactional included | Campaign recipient selection (Phase 7). **Never blocks `POST /emails`.** |

**Neither writes the other, in either direction, in this phase.** The failure this avoids is concrete: if unsubscribing a contact wrote a suppression, a customer who unsubscribes from a monthly newsletter stops receiving their password resets and their receipts. That is a support incident and, for receipts, a legal one. In the other direction: a hard bounce is not a withdrawal of consent — the address may be a typo in one book while the person is reachable elsewhere.

The one place they legitimately meet is **campaign recipient selection**, which must skip a contact whose address is suppressed. That is a read-time join, it belongs with campaigns, and it is recorded as a Phase 7 opener.

`POST /contacts/unsubscribe` therefore unsubscribes the address across **every book of the team** by default (the person said stop, not "stop for book A"), optionally narrowed with `bookId`, and writes no suppression row.

### 4. CSV import is buffered, capped and hand-parsed

- **Transport:** `POST /contact-books/:id/contacts/import` with JSON `{ "csv": "<the file>" }`. One envelope, one validator, one error shape — the same as every other v1 route. A raw `text/csv` body is an opener, not a second code path.
- **Caps:** 2 MB of CSV text, 10 000 data rows, 20 property columns, 500 characters per cell. The route refuses an oversized body from `content-length` _before_ reading it, the way `api/billing/webhook` does.
- **Buffered, not streamed, on purpose.** At 2 MB the whole file is smaller than one permitted email attachment; a streaming parser would be more code, more failure modes and no less memory, because the JSON envelope is buffered by `req.json()` regardless. Bigger lists are imported in chunks, and that is documented.
- **Malformed rows do not fail the import.** Each bad row is counted and reported (`errors[]`, capped at 100 entries) with its line number; good rows still land. An unterminated quote _is_ fatal — after it, every subsequent line's meaning is unknowable.
- **Duplicates inside one file:** the set is deduped by normalised email keeping the **last** occurrence, and the drops are counted as `duplicates`. This is not a nicety: Postgres refuses `ON CONFLICT DO UPDATE` when one statement touches the same key twice (`command cannot affect row a second time`), so an un-deduped chunk is a hard error on real customer data.
- **Formula injection is handled on export, where it belongs.** `csvCell()` prefixes any value beginning with `=`, `+`, `-`, `@`, tab or CR with a `'`, and quotes anything containing a double quote, a comma or a newline. Import does _not_ strip these: the value the customer uploaded is the value we store.

### 5. `template` together with `html`/`text` is a refusal, and `subject` becomes optional

The spec says "exactly one content source". Today `SendEmailInput` says "at least one", which was fine while `template` was rejected outright. Two changes to the shared contract:

- `template` together with `html` or `text` is a `validation_error`. Silently preferring one would make the other invisible.
- `subject` becomes **optional at the schema level**, because a template carries its own. The refine then requires `subject || template`, and a request-level `subject` overrides the template's. `EmailObject.subject` stays required — the stored subject is always resolved.

This is the only breaking-shaped change in the phase; it widens what is accepted, so no existing caller breaks.

### 6. Phase 4 opener 9 (`sending_only` and `GET /emails`) stays open

The brief asks whether templates make it more pressing. They do not, and the reasoning is worth keeping: a `sending_only` key sends _with_ a template through `POST /emails`, where the render happens server-side. It never needs to read a template. So every templates route requires a `full` key (they are management endpoints, like webhooks and API keys), `POST /:slug/render` included — it returns template content, so a sending-only key must not reach it. Nothing about templates argues for widening what a sending-only key can read. **Left open, unchanged.**

---

## Read first (existing code the tasks build on)

- `apps/web/src/services/emails.ts` — `createEmail`: the parse → address check → **idempotency lookup** → domain → suppression → caps → insert order. The render is inserted between address checking and the idempotency lookup, and the reason is in Task 8. `fingerprint()` and `applyTracking()` are what the rendered body flows through.
- `apps/web/src/services/suppressions.ts` — the CRUD-service shape this phase copies wholesale: `DENIED`, a `can(actor.role, …)` gate, `keysetPage` for the REST page, a `publicX()` view, `recordAudit` on every mutation, `Result<T>` everywhere.
- `apps/web/src/services/api-keys.ts` — `createApiKey`, for the "validate a referenced id belongs to the team, else `validation_error` with `details.field`" idiom.
- `apps/web/src/lib/api-response.ts` — `withApiKey`, `fail`, `ok`, `noContent`, `pagedList`, `parsePage`, `serviceFailure`, `readJson`, `tooLarge`, `RouteContext`.
- `apps/web/src/app/api/v1/suppressions/route.ts` and `.../[email]/route.ts` — the exact route shape (a `pagedList` GET, a `readJson` POST, a percent-decoded path segment).
- `apps/web/src/app/api/billing/webhook/route.ts` lines 7–52 — a route that declares **its own** body cap and checks `content-length` before reading. The CSV import route copies it.
- `apps/web/src/db/keyset.ts`, `apps/web/src/lib/cursor.ts` — `keysetPage` requires the table to have `id` _and_ a `timestamptz(3)` `createdAt`. Every list-able table added here has both.
- `apps/web/src/db/schema/suppressions.ts` and `.../emails.ts` — table conventions, and the `precision: 3` comment that explains itself.
- `apps/web/tests/integration/billing-schema.test.ts` — the `datetime_precision` guard against `information_schema.columns`. Task 4 copies it for the new tables.
- `apps/web/src/services/webhooks.ts` `fanOutEvent` — how a `contact.*` event reaches subscribers.
- `apps/web/src/services/retention.ts` `purgeOldBodies` — `emails.variables` joins `html`/`text` in the purge set (Task 4).
- `packages/shared/src/openapi.ts` — the `inputSchemas` / `outputSchemas` registries, the `op()` / `body()` / `errors()` helpers, and the `paths` object. `apps/web/tests/unit/openapi-coverage.test.ts` walks `src/app/api/v1` and fails on any route file with no entry **and** any entry with no route file, so the two grow together.
- `packages/sdk/src/types.ts` + `packages/sdk/tests/types-parity.test.ts` — hand-written public types, pinned to the zod contracts by a compile-time tuple (enforced by `bun run typecheck`, **not** vitest) plus runtime enum checks.
- `packages/sdk/tests/dist.test.ts` — the published `.d.ts` may not name `@sendsprite/shared`, `zod` or `react`; `dist/cli.js` may not name `@sendsprite/shared` or `zod`. **The CLI must not import the shared renderer.**
- `packages/sdk/src/cli/index.ts` — `COMMANDS` is the registry; a new command is one `registerTemplates` entry and nothing else.
- `packages/mcp/src/server.ts` `TOOLS`, `packages/mcp/src/tools/{register,result,output}.ts`, and `tools/send-email.ts` (a tool whose input schema _is_ a shared zod object).
- `apps/web/src/app/app/suppressions/{page.tsx,actions.ts,SuppressionsPanel.tsx}` — the whole dashboard idiom: server page → pre-formatted rows → client panel, `useActionState`, `useTransition`, `role="alert"`, the `glass` table, `Badge`, `EmptyState`, `can()` gating.
- `apps/web/src/app/app/emails/EmailDetail.tsx` line ~66 — `<iframe sandbox="" srcDoc={html}>`. The template preview uses exactly this.
- `apps/web/src/components/app/AppShell.tsx` — `NAV` already links `/app/templates` and `/app/contacts` at pages that do not exist. This phase makes both real.
- `apps/web/src/app/docs/webhooks/page.mdx` — the events table says `contact.*` is "Reserved for contacts (Phase 5)". It stops being reserved in Task 6.

---

## Conventions carried over from Phases 1–5

- Commit messages: conventional (`feat(templates): …`), **no `Co-Authored-By`, no AI attribution**.
- Every task ends green: `bun run typecheck && bun run lint && bun run format && bun run test` at the root, plus `bun run test:integration` when `apps/web` service, schema or route code changed.
- **Run vitest from inside `apps/web`** (`cd apps/web && bunx vitest run --project unit …`). `bunx vitest --root apps/web` from the repo root breaks `startPg`'s embedded Postgres.
- Schema: `pgTable("snake_case", { camelCase: type("snake_case") }, (t) => [ …indexes… ])`. **Never `pgEnum`** — always `text("col", { enum: TUPLE })` with an `as const` tuple. Ids are `text("id").primaryKey()` minted by `newId(prefix)` in app code, never a DB default, with a trailing comment naming the prefix. `teamId` is `text("team_id").notNull().references(() => organization.id, { onDelete: "cascade" })`.
- Timestamps are always `withTimezone: true`. **`precision: 3` on every timestamp that is keyset-paged or compared** — migration `0011` exists because a µs/ms mismatch silently skipped rows, and `billing-schema.test.ts` guards it with an `information_schema` query. Task 4 adds the same guard for the new tables.
- `updatedAt` uses `.$onUpdate(() => new Date())`, which **does not fire on `onConflictDoUpdate`** — every upsert sets `updatedAt: new Date()` explicitly. The CSV import is an upsert; this is not theoretical.
- Migrations: `bun run db:generate`, then rename the generated file to describe the change and edit the matching `tag` in `apps/web/drizzle/meta/_journal.json` (the 0009–0012 precedent).
- Services return `Result<T>`; only infrastructure errors throw. Server actions are thin: resolve the actor, delegate, `revalidatePath`.
- Audit action names are `<resource>.<verb>` (the convention Phase 5 wrote down): `templates.create`, `contactBooks.delete`, `contacts.import`.
- Integration tests use embedded Postgres via `tests/integration/_pg.ts` (**no Docker on the dev machine**); each file calls `startPg()` in `beforeAll` and imports `@/…` modules **dynamically afterwards**.
- **Never self-enqueue from a pg-boss `exclusive` queue handler.** This phase adds no queue and no cron; if a later reader is tempted to make CSV import a job, the rule still stands — sweeps are cron-driven from outside.
- The e2e suite runs against a **pre-built** server (`apps/web/scripts/e2e-server.ts`), so routes do not compile mid-test; `E2E_SERVER=dev` is the escape hatch. `bun run test:e2e` needs a Postgres on `localhost:5432` — start `bun run db:dev` first.

---

## Phase 6 openers — what this phase absorbs, and what it does not

Read the **Phase 6 openers** block at the end of `docs/superpowers/plans/2026-08-25-phase-5-billing.md` before starting. Disposition:

**This phase's body** is Phase 4 openers 1–4, carried over verbatim: templates + variables, contacts/audiences, CLI `templates pull|push`, MCP `list_templates`/`render_template`/`add_contact`, and the `/docs` templates page.

**Absorbed:**

- **Phase 4 opener 5 (audit rows for more mutations)** — partly. Every template and contact mutation writes an audit row through the existing `recordAudit` from the commit that creates it, so the audit-log **UI** (still deferred) will find them there. Nothing is retrofitted.
- **Phase 4 opener 8 (audit action naming)** — the `<resource>.<verb>` convention Phase 5 committed to is applied to thirteen new actions. Nothing existing is renamed.

**Explicitly out of scope, deferred to Phase 7:** campaigns and the block editor, the audit-log UI, the analytics overview. Also deferred, and for stated reasons rather than by omission: the public `/unsubscribe/:token` page and `List-Unsubscribe` headers (they need a campaign to unsubscribe _from_, and RFC 8058 one-click needs `List-Unsubscribe-Post` on a send this phase does not make); campaign recipient selection's suppression join; and a `contacts.imported` summary webhook event.

**Left alone, unchanged:** Phase 5 openers 1–7 (billing accuracy), 8–15 (provider/go-live), 16–18 (billing UI/ops), 19–22 (docs/tests/tooling), and Phase 4 openers 9 (see Decision 6), 10, 12–16, 17–25, 26–30.

**New openers this phase creates** are collected in Task 16's status block.

---

## File structure

```
packages/shared/src/
  template.ts                        NEW: escapeHtml, placeholderNames, renderTemplate,
                                          MAX_PLACEHOLDERS, MAX_RENDERED_CHARS. Pure, no deps,
                                          runs in the browser (the dashboard preview uses it).
  api/templates.ts                   NEW: TEMPLATE_VARIABLE_TYPES, TemplateVariable,
                                          TemplateVariablesSchema, TemplateSlug,
                                          CreateTemplateInput, UpdateTemplateInput,
                                          TemplateObject, TemplateVersionObject,
                                          RenderTemplateInput, RenderedTemplateObject
  api/contacts.ts                    NEW: CreateContactBookInput, UpdateContactBookInput,
                                          ContactBookObject, CreateContactInput,
                                          UpdateContactInput, ContactObject, ListContactsQuery,
                                          ImportContactsInput, ImportContactsResult,
                                          UnsubscribeContactInput, UnsubscribeResult
  api/emails.ts                      subject optional + two refines (modified)
  index.ts                           + three exports (modified)
  openapi.ts                         + 9 paths, 2 tags, 20 schemas (modified)

apps/web/
  drizzle/0013_templates_contacts.sql   NEW (generated, then renamed + journal tag edited)
  src/db/schema/templates.ts            NEW: templates, templateVersions
  src/db/schema/contacts.ts             NEW: contactBooks, contacts
  src/db/schema/emails.ts               + templateId, variables (modified)
  src/db/schema/index.ts                + two exports (modified)
  src/lib/csv.ts                        NEW: parseCsv, toCsv, csvCell, MAX_CSV_BYTES, MAX_CSV_ROWS
  src/services/templates.ts             NEW: CRUD, versions, findTemplate, renderStoredTemplate
  src/services/contacts.ts              NEW: books CRUD, contacts CRUD, import, unsubscribe
  src/services/emails.ts                template render on the send path (modified)
  src/services/retention.ts             + variables in the purge set (modified)

  src/app/api/v1/templates/route.ts                                  NEW
  src/app/api/v1/templates/[slug]/route.ts                           NEW
  src/app/api/v1/templates/[slug]/render/route.ts                    NEW
  src/app/api/v1/contact-books/route.ts                              NEW
  src/app/api/v1/contact-books/[id]/route.ts                         NEW
  src/app/api/v1/contact-books/[id]/contacts/route.ts                NEW
  src/app/api/v1/contact-books/[id]/contacts/[contactId]/route.ts    NEW
  src/app/api/v1/contact-books/[id]/contacts/import/route.ts         NEW
  src/app/api/v1/contacts/unsubscribe/route.ts                       NEW

  src/app/app/templates/page.tsx                   NEW  list
  src/app/app/templates/actions.ts                 NEW
  src/app/app/templates/TemplateList.tsx           NEW
  src/app/app/templates/new/page.tsx               NEW
  src/app/app/templates/[slug]/page.tsx            NEW  editor + preview + history
  src/app/app/templates/[slug]/TemplateEditor.tsx  NEW
  src/app/app/contacts/page.tsx                    NEW  books
  src/app/app/contacts/actions.ts                  NEW
  src/app/app/contacts/BooksPanel.tsx              NEW
  src/app/app/contacts/[bookId]/page.tsx           NEW  contacts in one book
  src/app/app/contacts/[bookId]/ContactsPanel.tsx  NEW
  src/app/app/contacts/[bookId]/export/route.ts    NEW  CSV download (session auth)
  src/app/docs/templates/page.mdx                  NEW
  src/app/docs/contacts/page.mdx                   NEW
  src/app/docs/nav.ts                              + two entries (modified)
  src/app/docs/webhooks/page.mdx                   contact.* is no longer "reserved" (modified)

  tests/unit/csv.test.ts                      NEW
  tests/integration/templates-schema.test.ts  NEW
  tests/integration/templates.test.ts         NEW
  tests/integration/contacts.test.ts          NEW
  tests/integration/rest-templates.test.ts    NEW
  tests/integration/rest-contacts.test.ts     NEW
  tests/integration/emails.test.ts            + template send cases (modified)
  tests/integration/retention.test.ts         + variables purge case (modified)
  tests/e2e/templates.spec.ts                 NEW

packages/shared/tests/
  template-render.test.ts            NEW
  api-templates.test.ts              NEW
  api-contacts.test.ts               NEW
  openapi.test.ts                    + the new paths (modified)

packages/sdk/src/
  types.ts                           + templates and contacts types (modified)
  resources/templates.ts             NEW
  resources/contact-books.ts         NEW
  resources/contacts.ts              NEW
  index.ts                           + three namespaces (modified)
  cli/commands/templates.ts          NEW: `templates pull|push <dir>`
  cli/index.ts                       + registerTemplates (modified)
packages/sdk/tests/
  types-parity.test.ts               + 20 checks (modified)
  resources.test.ts                  + the new namespaces (modified)
  cli.test.ts                        + pull/push (modified)

packages/mcp/src/
  tools/list-templates.ts            NEW
  tools/render-template.ts           NEW
  tools/add-contact.ts               NEW
  tools/output.ts                    + renderedTemplateOutput, contactOutput (modified)
  server.ts                          + three tools (modified)
packages/mcp/tests/server.test.ts    + the new tools (modified)

.changeset/phase-6-templates-contacts.md   NEW (sendsprite + @sendsprite/mcp minor)
README.md                                  + templates/contacts paragraphs, roadmap (modified)
```

---

## Behaviour change to announce in Task 16's changeset

`NO_CONTROL_CHARS` replaced the two `NO_CRLF` copies, so the whole email API now refuses **any**
C0 control character or DEL — not just CR and LF — in `subject`, `from`/`to`/`cc`/`bcc`/
`replyTo`, attachment `filename` and `contentType`, custom header values and tag values.

That includes **HTAB**, which RFC 5322 permits as WSP in an unstructured header. So a customer
who puts a tab in a subject now gets a 422 where they previously got a send. Keep it: tab is the
folding-continuation character and therefore the second half of a header-injection primitive,
NUL truncates C strings downstream, and ESC is the RFC 2047 charset-switching lead-in. Nothing
is published to npm yet and there are no production users, so the cost of tightening is zero
today and non-zero forever after.

It must be **announced**, not shipped silently: name it in the changeset and in `/docs/sending`,
and make sure the validation message says "line breaks or control characters" rather than
"line breaks" — otherwise a customer with a tab is told their subject contains a line break,
which is both wrong and unactionable.

## Carry-forwards for Task 7 (from the Task 3 contracts)

- **Normalise emails identically on both sides.** The contract's email schema is
  `.trim().toLowerCase().max(320).pipe(z.email())`, the same idiom as `AddSuppressionInput`. The
  `(book_id, email)` uniqueness constraint must store that same normalised form, or the
  idempotency promise on unsubscribe and the dedupe in CSV import both break for any address
  that differs only in case or whitespace.
- **Truncate the import error list in the service.** `ImportContactsResult.errors` caps at 100,
  but that is a _response_ validator: if Task 7 returns more, a large bad file turns into a
  serialisation failure instead of the error report the customer needs. Truncate at the source
  and say how many were omitted.
- **`SUPPRESSION_REASONS` already contains `"unsubscribe"`**, meaning "remove from all mail".
  That is a different thing from `contacts.subscribed = false`, and the similar name is exactly
  the trap the separation exists to avoid. Do not let one write the other.

## Amendment after the Task 1 review — empty values, nulls, and escaping scope

**Empty string counts as missing.** Decision 2 exists so nobody mails "Hi ," to a whole list —
but an empty string is a _supplied_ value, so it sails through, and a blank CSV cell or an unset
contact field produces `""`, not `undefined`. The refusal was firing for the case that is easy
to notice and not for the case that actually happens at volume. So `""` and whitespace-only are
treated as **missing**: they take a declared `default` if there is one, and are refused
otherwise. A genuinely empty value is expressed by declaring `default: ""` in the schema, which
is explicit rather than accidental. Task 4's CSV import must not paper over this by mapping
blank cells to `""`.

**JSON `null` takes the default.** `null` is the natural wire encoding of "no value" and is what
a nullable column serialises to, so a declared default must apply to it rather than being
skipped because `null !== undefined`.

**Escaping scope is element text and quoted attributes only.** Values are not safe in unquoted
or backtick-delimited attributes unless `` ` `` and `=` are escaped (escaping `=` is what
actually stops the breakout, since attribute _names_ are not entity-decoded), and are out of
scope inside `<style>`, `<script>` and URL-scheme positions. State this in the module docstring
rather than implying a broader guarantee — and render the dashboard preview in a sandboxed
iframe, which is what actually covers the URL-scheme case.

**Size the per-value cap against the 500× multiplier.** The amplification is per-value ×
`MAX_PLACEHOLDERS` × up to 6 for escaping, so only the per-value cap bounds the blast radius —
the serialised-payload cap does not. Task 2's 2 000 chars gives a worst case around 12 MB of
transient UTF-16, which is the right order. The renderer additionally needs its **own**
incremental check, because the dashboard preview imports it directly with no contract in front
of it.

## Amendment after Task 1 — cap the variables payload

`renderTemplate` enforces `MAX_RENDERED_CHARS` **after** building the string. With up to 500
placeholder occurrences allowed per field and `RenderTemplateInput.variables` typed as an
uncapped `z.record(z.string(), z.unknown())`, one large value repeated across placeholders
allocates far more than the limit before the refusal fires — bounded only by the route's body
cap multiplied by 500. That is a memory-amplification vector on `POST /templates/:slug/render`
and on any send carrying variables.

Close it at the contract, not in the renderer: **Task 2 must bound the `variables` payload** —
a cap on the number of keys, a cap on each value's length, and a cap on the serialised total.
Reject at parse time with a message naming what was exceeded. The renderer's own limit stays as
a second line of defence; do not remove it. If a value legitimately needs to be larger than the
per-value cap, that is what the `html` field is for.

## Decisions confirmed before implementation

All six open questions in this plan are confirmed as drafted. Reasoning recorded so an
implementer does not reopen them:

1. **No unescaped placeholder form, ever.** No `{{{ }}}`, no opt-out. A per-recipient HTML
   fragment goes through the `html` field directly. Shipping an injection vector is not
   recoverable; adding a sanitised opt-in later is.
2. **Missing variables are a refusal, not an empty string.** Competitors substitute nothing and
   mail "Hi ," to a customer's whole list. A 400 naming the variable is a support ticket; the
   alternative is the customer's embarrassment, at volume, unrecoverably. `variables_schema`
   defaults are the escape hatch.
3. **`slug` is immutable.** A live send names a template by slug, so a rename is a silent
   production break. Create + delete is explicit about what it costs.
4. **CSV import stays JSON-only**, 2 MB / 10 000 rows, for this phase. Raw `text/csv` and
   streamed large imports are Phase 7 openers — but make the over-limit error say plainly that
   the file must be split, because a customer migrating from another ESP will hit it on day one
   and the message is the whole experience at that moment.
5. **Book delete requires `settings.manage`; every other contact mutation `contacts.manage`.**
   An irreversible bulk cascade deserves a higher bar than editing one row.
6. **Public `/unsubscribe/:token` and RFC 8058 `List-Unsubscribe` stay in Phase 7**, with
   campaigns — there is nothing to unsubscribe _from_ until then, and `List-Unsubscribe-Post`
   belongs on a send this phase does not make.

## Task 1: The renderer

The security-critical core, written first and on its own so it is tested without a database, a route or a React tree in the way. Pure, dependency-free and browser-safe: the dashboard's live preview imports this exact function, so the preview cannot disagree with the send.

**Files:**

- Create: `packages/shared/src/template.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/tests/template-render.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/tests/template-render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_PLACEHOLDERS,
  escapeHtml,
  placeholderNames,
  renderTemplate,
} from "../src/index";

const base = {
  subject: "Hi {{ name }}",
  bodyHtml: "<p>Hello {{name}}</p>",
  bodyText: "Hello {{name}}",
};

describe("escapeHtml", () => {
  it("escapes the five characters that matter and nothing else", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(escapeHtml("plain — text 한글 ✉")).toBe("plain — text 한글 ✉");
  });
});

describe("placeholderNames", () => {
  it("finds names once each, in order, tolerating whitespace", () => {
    expect(
      placeholderNames("{{a}} {{ b }} {{a}} {{ user.first_name }}"),
    ).toEqual(["a", "b", "user.first_name"]);
  });

  it("ignores anything that is not a well-formed placeholder", () => {
    expect(
      placeholderNames("{{ }} {{1bad}} {{a-b}} { {a} } {{unclosed"),
    ).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("substitutes into all three fields", () => {
    const r = renderTemplate(base, { name: "Mingu" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toEqual({
      subject: "Hi Mingu",
      html: "<p>Hello Mingu</p>",
      text: "Hello Mingu",
    });
  });

  it("HTML-escapes values in bodyHtml and leaves bodyText and subject alone", () => {
    const r = renderTemplate(base, { name: `<b>&"x"</b>` });
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.html).toBe(
      "<p>Hello &lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;</p>",
    );
    expect(r.data.text).toBe(`Hello <b>&"x"</b>`);
    expect(r.data.subject).toBe(`Hi <b>&"x"</b>`);
  });

  it("refuses a rendered subject carrying CR or LF (header injection)", () => {
    const r = renderTemplate(base, { name: "x\r\nBcc: evil@x.io" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/line breaks/i);
  });

  it("refuses an empty or over-long rendered subject", () => {
    expect(
      renderTemplate({ ...base, subject: "{{name}}" }, { name: "  " }).ok,
    ).toBe(false);
    expect(
      renderTemplate(
        { ...base, subject: "{{name}}" },
        { name: "x".repeat(999) },
      ).ok,
    ).toBe(false);
  });

  it("names every missing variable instead of rendering an empty string", () => {
    const r = renderTemplate(
      { subject: "{{a}}", bodyHtml: "{{b}} {{c}}", bodyText: null },
      { b: "1" },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.missing).toEqual(["a", "c"]);
    expect(r.error).toMatch(/a, c/);
  });

  it("uses a declared default for a variable the caller omitted", () => {
    const r = renderTemplate(
      base,
      {},
      {
        variables: [
          { name: "name", type: "string", required: false, default: "there" },
        ],
      },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.subject).toBe("Hi there");
  });

  it("renders numbers and booleans, refuses objects and arrays", () => {
    const t = { subject: "s", bodyHtml: "{{n}}/{{b}}", bodyText: null };
    const ok = renderTemplate(t, { n: 42, b: false });
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.data.html).toBe("42/false");
    const bad = renderTemplate(t, { n: { deep: 1 }, b: [1, 2] });
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("unreachable");
    expect(bad.invalid).toEqual(["n", "b"]);
  });

  it("treats null and NaN as missing rather than as values", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a}}{{b}}", bodyText: null },
      {
        a: null,
        b: Number.NaN,
      },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.missing).toEqual(["a", "b"]);
  });

  it("walks dotted paths, and only through plain objects", () => {
    const t = { subject: "s", bodyHtml: "{{user.name}}", bodyText: null };
    const ok = renderTemplate(t, { user: { name: "Mingu" } });
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.data.html).toBe("Mingu");
    // A prototype-chain lookup must not resolve: `constructor` is not data.
    const proto = renderTemplate(
      { subject: "s", bodyHtml: "{{a.constructor}}", bodyText: null },
      { a: {} },
    );
    expect(proto.ok).toBe(false);
  });

  it("does not re-scan substituted text (no expansion bomb)", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a}}", bodyText: null },
      { a: "{{a}}{{a}}" },
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.html).toBe("{{a}}{{a}}");
  });

  it("refuses a value whose declared type does not match", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{n}}", bodyText: null },
      { n: "12" },
      { variables: [{ name: "n", type: "number", required: true }] },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.invalid).toEqual(["n"]);
  });

  it("refuses a body with more placeholders than MAX_PLACEHOLDERS", () => {
    const many = "{{a}}".repeat(MAX_PLACEHOLDERS + 1);
    expect(
      renderTemplate(
        { subject: "s", bodyHtml: many, bodyText: null },
        { a: "x" },
      ).ok,
    ).toBe(false);
  });

  it("refuses a render that blows past the stored-body limit", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "{{a}}", bodyText: null },
      { a: "x".repeat(5_000_001) },
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/too large/i);
  });

  it("passes a null bodyText through as null", () => {
    const r = renderTemplate(
      { subject: "s", bodyHtml: "x", bodyText: null },
      {},
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.text).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && bunx vitest run tests/template-render.test.ts`
Expected: FAIL — `renderTemplate` and friends are not exported from `../src/index`.

- [ ] **Step 3: Write `packages/shared/src/template.ts`**

```ts
/**
 * The Sendsprite template renderer.
 *
 * Pure, dependency-free and browser-safe on purpose: the send path, the
 * `POST /templates/:slug/render` endpoint and the dashboard's live preview all
 * call this one function, so a preview cannot disagree with what is sent.
 *
 * The syntax is `{{ name }}` and nothing else — no helpers, no filters, no
 * conditionals, no loops, and **no unescaped form**. A template engine's value
 * is its expression language and its expression language is its attack
 * surface; this renders third-party data into HTML that is then emailed, so
 * there is deliberately no language to sandbox.
 *
 * Escaping is a property of the *field*:
 *   - `bodyHtml` HTML-escapes every substituted value;
 *   - `bodyText` does not (it is not markup);
 *   - `subject` does not, but the **rendered** result is re-checked for CR/LF,
 *     because `SendEmailInput`'s no-line-breaks rule only sees what the client
 *     sent and a rendered subject bypasses it by construction. That check is
 *     the header-injection guard.
 */

/** Placeholder: `{{ name }}` or `{{ a.b.c }}`, whitespace tolerated. */
const PLACEHOLDER =
  /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3})\s*\}\}/g;

/** Placeholders allowed in one field. A template is authored, not generated. */
export const MAX_PLACEHOLDERS = 500;
/** Matches the `html`/`text` bound in `SendEmailInput`, so a render cannot produce an unstorable body. */
export const MAX_RENDERED_CHARS = 5_000_000;
/** RFC 5322 line-length bound, same as `SendEmailInput.subject`. */
export const MAX_SUBJECT_CHARS = 998;

const HTML_ENTITY: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** The five characters that can break out of HTML text or an attribute value. */
export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => HTML_ENTITY[c] as string);

/** Every placeholder name in `source`, deduplicated, in first-seen order. */
export function placeholderNames(source: string): string[] {
  const seen: string[] = [];
  for (const m of source.matchAll(PLACEHOLDER)) {
    const name = m[1] as string;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** What a stored template supplies. `bodyText` is optional in the API and in the table. */
export interface TemplateSource {
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
}

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string | null;
}

/** Only the fields the renderer reads; the full schema lives in `api/templates.ts`. */
export interface RenderVariableSpec {
  name: string;
  type?: "string" | "number" | "boolean";
  required?: boolean;
  default?: string | number | boolean;
}
export interface RenderVariablesSchema {
  variables: RenderVariableSpec[];
}

export type RenderTemplateResult =
  | { ok: true; data: RenderedTemplate }
  | {
      ok: false;
      error: string;
      /** Placeholders with no value and no default. */
      missing: string[];
      /** Placeholders whose value is not a renderable scalar, or is the wrong declared type. */
      invalid: string[];
    };

const fail = (
  error: string,
  missing: string[] = [],
  invalid: string[] = [],
): RenderTemplateResult => ({ ok: false, error, missing, invalid });

/** `{}`-literal objects only: a prototype-chain hit is not data the caller passed. */
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Walks a dotted path through own enumerable properties only, so
 * `{{a.constructor}}` and `{{a.__proto__.x}}` resolve to nothing rather than
 * to a function or to something an attacker planted up the chain.
 */
function lookup(values: Record<string, unknown>, path: string): unknown {
  let node: unknown = values;
  for (const key of path.split(".")) {
    if (!isPlainObject(node)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

type Resolved =
  { kind: "value"; text: string } | { kind: "missing" } | { kind: "invalid" };

function resolve(value: unknown, declared?: RenderVariableSpec): Resolved {
  if (value === undefined || value === null) return { kind: "missing" };
  if (typeof value === "number") {
    // NaN and Infinity are arithmetic accidents, not values worth emailing.
    if (!Number.isFinite(value)) return { kind: "missing" };
    if (declared?.type && declared.type !== "number")
      return { kind: "invalid" };
    return { kind: "value", text: String(value) };
  }
  if (typeof value === "boolean") {
    if (declared?.type && declared.type !== "boolean")
      return { kind: "invalid" };
    return { kind: "value", text: value ? "true" : "false" };
  }
  if (typeof value === "string") {
    if (declared?.type && declared.type !== "string")
      return { kind: "invalid" };
    return { kind: "value", text: value };
  }
  // Objects, arrays, functions, symbols, bigints: `[object Object]` in a
  // customer's inbox is a bug, and JSON-stringifying user data into HTML is a
  // larger escaping surface than this renderer wants.
  return { kind: "invalid" };
}

/**
 * Renders one field. Substituted text is **never re-scanned** — `replace` with
 * a function walks the source once — so a value containing `{{x}}` emits the
 * literal `{{x}}` and no input can make the renderer expand exponentially.
 */
function renderField(
  source: string,
  values: Record<string, unknown>,
  declared: Map<string, RenderVariableSpec>,
  escape: boolean,
  missing: Set<string>,
  invalid: Set<string>,
): string {
  return source.replace(PLACEHOLDER, (_match, rawName: string) => {
    const name = rawName;
    const spec = declared.get(name);
    const raw = lookup(values, name);
    const r = resolve(raw === undefined ? spec?.default : raw, spec);
    if (r.kind === "missing") {
      missing.add(name);
      return "";
    }
    if (r.kind === "invalid") {
      invalid.add(name);
      return "";
    }
    return escape ? escapeHtml(r.text) : r.text;
  });
}

/**
 * Renders a template's three fields together.
 *
 * Every placeholder must resolve: a missing value is a refusal naming it, not
 * an empty string, because "Hi ," at volume is discovered by a customer rather
 * than by us. Declare the variable with a `default` in `variables_schema` to
 * make it genuinely optional.
 */
export function renderTemplate(
  template: TemplateSource,
  variables: Record<string, unknown> = {},
  schema?: RenderVariablesSchema | null,
): RenderTemplateResult {
  for (const field of [template.subject, template.bodyHtml, template.bodyText])
    if (field && placeholderNames(field).length > MAX_PLACEHOLDERS)
      return fail(
        `A template field may use at most ${MAX_PLACEHOLDERS} variables.`,
      );

  const declared = new Map<string, RenderVariableSpec>();
  for (const v of schema?.variables ?? []) declared.set(v.name, v);

  const missing = new Set<string>();
  const invalid = new Set<string>();
  const render = (s: string, escape: boolean) =>
    renderField(s, variables, declared, escape, missing, invalid);

  const subject = render(template.subject, false);
  const html = render(template.bodyHtml, true);
  const text =
    template.bodyText === null ? null : render(template.bodyText, false);

  if (missing.size || invalid.size) {
    const parts: string[] = [];
    if (missing.size) parts.push(`missing: ${[...missing].join(", ")}`);
    if (invalid.size)
      parts.push(`not a string, number or boolean: ${[...invalid].join(", ")}`);
    return fail(
      `Template variables ${parts.join("; ")}.`,
      [...missing],
      [...invalid],
    );
  }

  // The rendered subject, not the authored one, is what reaches the MIME
  // header — so it is checked here and nowhere else can catch it.
  const trimmedSubject = subject.trim();
  if (/[\r\n]/.test(subject))
    return fail("The rendered subject must not contain line breaks.");
  if (trimmedSubject.length === 0)
    return fail("The rendered subject is empty.");
  if (trimmedSubject.length > MAX_SUBJECT_CHARS)
    return fail(
      `The rendered subject must be at most ${MAX_SUBJECT_CHARS} characters.`,
    );
  if (
    html.length > MAX_RENDERED_CHARS ||
    (text?.length ?? 0) > MAX_RENDERED_CHARS
  )
    return fail("The rendered body is too large.");

  return { ok: true, data: { subject: trimmedSubject, html, text } };
}
```

- [ ] **Step 4: Export it from the barrel**

In `packages/shared/src/index.ts`, add after `export * from "./roles";`:

```ts
export * from "./template";
```

`packages/shared/tests/root-barrel.test.ts` walks the import graph from `index.ts` and asserts no `node:` builtin is reachable. `template.ts` imports nothing, so it stays green — but the walker now covers it, which is the point.

- [ ] **Step 5: Run it to verify it passes**

Run: `cd packages/shared && bunx vitest run`
Expected: PASS, `root-barrel.test.ts` included.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): {{variable}} template renderer with field-aware escaping"
```

---

## Task 2: Shared contracts — templates

The zod contracts the REST layer, the OpenAPI document and the SDK's hand-written types all answer to.

**Files:**

- Create: `packages/shared/src/api/templates.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/tests/api-templates.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/tests/api-templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CreateTemplateInput,
  RenderTemplateInput,
  TemplateObject,
  TemplateVariablesSchema,
  UpdateTemplateInput,
  slugifyTemplateName,
} from "../src/index";

describe("CreateTemplateInput", () => {
  it("accepts the minimum and defaults the optional halves", () => {
    const p = CreateTemplateInput.parse({
      slug: "welcome",
      name: "Welcome",
      subject: "Hi {{name}}",
      bodyHtml: "<p>Hi {{name}}</p>",
    });
    expect(p).toMatchObject({
      slug: "welcome",
      bodyText: undefined,
      variablesSchema: { variables: [] },
    });
  });

  it("lower-cases and validates the slug", () => {
    expect(
      CreateTemplateInput.parse({
        slug: "  Welcome-Email ",
        name: "n",
        subject: "s",
        bodyHtml: "b",
      }).slug,
    ).toBe("welcome-email");
    for (const slug of [
      "",
      "a b",
      "UPPER CASE!",
      "-lead",
      "trail-",
      "a".repeat(65),
    ])
      expect(
        CreateTemplateInput.safeParse({
          slug,
          name: "n",
          subject: "s",
          bodyHtml: "b",
        }).success,
      ).toBe(false);
  });

  it("refuses a subject with line breaks even before rendering", () => {
    expect(
      CreateTemplateInput.safeParse({
        slug: "a",
        name: "n",
        subject: "one\ntwo",
        bodyHtml: "b",
      }).success,
    ).toBe(false);
  });

  it("refuses a body that uses more than 500 variables", () => {
    expect(
      CreateTemplateInput.safeParse({
        slug: "a",
        name: "n",
        subject: "s",
        bodyHtml: "{{a}}".repeat(501),
      }).success,
    ).toBe(false);
  });
});

describe("TemplateVariablesSchema", () => {
  it("defaults type and required, and keeps a default value", () => {
    expect(
      TemplateVariablesSchema.parse({
        variables: [{ name: "name", default: "there" }],
      }),
    ).toEqual({
      variables: [
        { name: "name", type: "string", required: true, default: "there" },
      ],
    });
  });

  it("refuses a variable name the renderer could never match", () => {
    for (const name of ["1bad", "a-b", "", "a b"])
      expect(
        TemplateVariablesSchema.safeParse({ variables: [{ name }] }).success,
      ).toBe(false);
    expect(
      TemplateVariablesSchema.safeParse({ variables: [{ name: "user.first" }] })
        .success,
    ).toBe(true);
  });
});

describe("UpdateTemplateInput", () => {
  it("needs at least one field", () => {
    expect(UpdateTemplateInput.safeParse({}).success).toBe(false);
    expect(UpdateTemplateInput.safeParse({ name: "New" }).success).toBe(true);
  });
});

describe("RenderTemplateInput", () => {
  it("defaults variables to an empty record", () => {
    expect(RenderTemplateInput.parse({})).toEqual({ variables: {} });
  });
});

describe("TemplateObject", () => {
  it("parses what the REST layer returns", () => {
    expect(
      TemplateObject.safeParse({
        id: "tpl_1",
        slug: "welcome",
        name: "Welcome",
        subject: "Hi",
        bodyHtml: "<p>Hi</p>",
        bodyText: null,
        variablesSchema: { variables: [] },
        version: 3,
        updatedBy: null,
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("slugifyTemplateName", () => {
  it("produces a slug the schema accepts", () => {
    expect(slugifyTemplateName("  Welcome Email!  ")).toBe("welcome-email");
    expect(slugifyTemplateName("한글 Only")).toBe("only");
    expect(slugifyTemplateName("!!!")).toBe("");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && bunx vitest run tests/api-templates.test.ts`
Expected: FAIL — nothing is exported from `../src/index`.

- [ ] **Step 3: Write `packages/shared/src/api/templates.ts`**

```ts
import { z } from "zod";
import {
  MAX_PLACEHOLDERS,
  MAX_SUBJECT_CHARS,
  placeholderNames,
} from "../template";

/**
 * Contracts for `/api/v1/templates` (spec §7). Shared with the SDK and the
 * OpenAPI generator, so every schema here must stay
 * `z.toJSONSchema`-representable: `.refine` is fine (it is ignored by the
 * emitter), `.transform` is not.
 */

/** URL key of a template: lower-case, digits and single dashes. */
export const TEMPLATE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const TemplateSlug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Slug is required.")
  .max(64, "Slug is too long.")
  .regex(TEMPLATE_SLUG_RE, "Use lower-case letters, digits and dashes.");

/** Best-effort name → slug for the dashboard's "new template" form. May return "". */
export const slugifyTemplateName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const TEMPLATE_VARIABLE_TYPES = ["string", "number", "boolean"] as const;
export type TemplateVariableType = (typeof TEMPLATE_VARIABLE_TYPES)[number];

/** Must match what the renderer's placeholder pattern can address. */
const VARIABLE_NAME = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/,
    "Use letters, digits and underscores, optionally dotted.",
  );

/**
 * One declared variable. `default` is the only supported way to make a
 * placeholder optional — the renderer refuses a missing value outright — and
 * it is what the editor shows as the sample value in the live preview.
 */
export const TemplateVariable = z.object({
  name: VARIABLE_NAME,
  type: z.enum(TEMPLATE_VARIABLE_TYPES).default("string"),
  required: z.boolean().default(true),
  default: z.union([z.string().max(2000), z.number(), z.boolean()]).optional(),
  description: z.string().trim().max(200).optional(),
});
export type TemplateVariable = z.infer<typeof TemplateVariable>;

export const TemplateVariablesSchema = z.object({
  variables: z.array(TemplateVariable).max(100).default([]),
});
export type TemplateVariablesSchema = z.infer<typeof TemplateVariablesSchema>;

const NO_CRLF = /^[^\r\n]*$/;
const subject = z
  .string()
  .trim()
  .min(1, "Subject is required.")
  .max(MAX_SUBJECT_CHARS)
  .regex(NO_CRLF, "Subject must not contain line breaks.");

/** 5 MB, the same bound `SendEmailInput` puts on `html`/`text`. */
const body = z.string().max(5_000_000);

/** A body may not use more variables than the renderer will substitute. */
const withinPlaceholderLimit = (s: string | undefined) =>
  s === undefined || placeholderNames(s).length <= MAX_PLACEHOLDERS;

export const CreateTemplateInput = z
  .object({
    slug: TemplateSlug,
    name: z.string().trim().min(1, "Name is required.").max(120),
    subject,
    bodyHtml: body.min(1, "An HTML body is required."),
    bodyText: body.optional(),
    variablesSchema: TemplateVariablesSchema.default({ variables: [] }),
  })
  .refine(
    (t) =>
      withinPlaceholderLimit(t.subject) &&
      withinPlaceholderLimit(t.bodyHtml) &&
      withinPlaceholderLimit(t.bodyText),
    {
      message: `A template field may use at most ${MAX_PLACEHOLDERS} variables.`,
    },
  );
export type CreateTemplateInput = z.infer<typeof CreateTemplateInput>;

/**
 * Every field optional, at least one present. `slug` is deliberately absent:
 * renaming the key of a template that a live `POST /emails` names by slug is a
 * silent outage, so a rename is a create plus a delete.
 */
export const UpdateTemplateInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    subject,
    bodyHtml: body.min(1),
    bodyText: body.nullable(),
    variablesSchema: TemplateVariablesSchema,
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "Nothing to update.")
  .refine(
    (t) =>
      withinPlaceholderLimit(t.subject) &&
      withinPlaceholderLimit(t.bodyHtml) &&
      withinPlaceholderLimit(t.bodyText ?? undefined),
    {
      message: `A template field may use at most ${MAX_PLACEHOLDERS} variables.`,
    },
  );
export type UpdateTemplateInput = z.infer<typeof UpdateTemplateInput>;

export const TemplateObject = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  subject: z.string(),
  bodyHtml: z.string(),
  bodyText: z.string().nullable(),
  variablesSchema: TemplateVariablesSchema,
  /** Bumped on every content change; `template_versions` holds each one. */
  version: z.number().int(),
  updatedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TemplateObject = z.infer<typeof TemplateObject>;

/** One entry of the version history. `snapshot` is the template as it was at that version. */
export const TemplateVersionObject = z.object({
  version: z.number().int(),
  snapshot: z.object({
    name: z.string(),
    subject: z.string(),
    bodyHtml: z.string(),
    bodyText: z.string().nullable(),
    variablesSchema: TemplateVariablesSchema,
  }),
  createdBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type TemplateVersionObject = z.infer<typeof TemplateVersionObject>;

/** `POST /templates/:slug/render` — a dry run, nothing is sent or stored. */
export const RenderTemplateInput = z.object({
  variables: z.record(z.string(), z.unknown()).default({}),
});
export type RenderTemplateInput = z.infer<typeof RenderTemplateInput>;

export const RenderedTemplateObject = z.object({
  subject: z.string(),
  html: z.string(),
  text: z.string().nullable(),
});
export type RenderedTemplateObject = z.infer<typeof RenderedTemplateObject>;
```

- [ ] **Step 4: Export it from the barrel**

In `packages/shared/src/index.ts`, add after `export * from "./api/suppressions";`:

```ts
export * from "./api/templates";
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd packages/shared && bunx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): template contracts and variables schema"
```

---

## Task 3: Shared contracts — contacts

**Files:**

- Create: `packages/shared/src/api/contacts.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/tests/api-contacts.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/tests/api-contacts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ContactObject,
  CreateContactBookInput,
  CreateContactInput,
  ImportContactsInput,
  ImportContactsResult,
  ListContactsQuery,
  UnsubscribeContactInput,
  UpdateContactInput,
} from "../src/index";

describe("CreateContactBookInput", () => {
  it("requires a name and accepts an optional default from-address", () => {
    expect(CreateContactBookInput.parse({ name: " Newsletter " })).toEqual({
      name: "Newsletter",
    });
    expect(
      CreateContactBookInput.safeParse({
        name: "n",
        defaultFrom: "not an address",
      }).success,
    ).toBe(false);
    expect(
      CreateContactBookInput.safeParse({
        name: "n",
        defaultFrom: "Acme <a@b.io>",
      }).success,
    ).toBe(true);
    expect(CreateContactBookInput.safeParse({ name: "" }).success).toBe(false);
  });
});

describe("CreateContactInput", () => {
  it("normalises the address and defaults subscribed to true", () => {
    expect(CreateContactInput.parse({ email: "  A@B.IO " })).toEqual({
      email: "a@b.io",
      subscribed: true,
      properties: {},
    });
  });

  it("rejects a bad address and over-long property values", () => {
    expect(CreateContactInput.safeParse({ email: "nope" }).success).toBe(false);
    expect(
      CreateContactInput.safeParse({
        email: "a@b.io",
        properties: { plan: "x".repeat(501) },
      }).success,
    ).toBe(false);
  });

  it("caps the number of properties", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]),
    );
    expect(
      CreateContactInput.safeParse({ email: "a@b.io", properties }).success,
    ).toBe(false);
  });
});

describe("UpdateContactInput", () => {
  it("needs at least one field and can flip subscription", () => {
    expect(UpdateContactInput.safeParse({}).success).toBe(false);
    expect(UpdateContactInput.parse({ subscribed: false })).toEqual({
      subscribed: false,
    });
  });
});

describe("ListContactsQuery", () => {
  it("carries the page params plus a search term and a subscription filter", () => {
    expect(
      ListContactsQuery.parse({ q: " ac ", subscribed: "false" }),
    ).toMatchObject({
      limit: 25,
      q: "ac",
      subscribed: false,
    });
  });
});

describe("ImportContactsInput", () => {
  it("requires csv text and defaults the flags", () => {
    expect(ImportContactsInput.parse({ csv: "email\na@b.io" })).toEqual({
      csv: "email\na@b.io",
      updateExisting: true,
    });
    expect(ImportContactsInput.safeParse({ csv: "" }).success).toBe(false);
    expect(
      ImportContactsInput.safeParse({ csv: "x".repeat(2 * 1024 * 1024 + 1) })
        .success,
    ).toBe(false);
  });
});

describe("ImportContactsResult", () => {
  it("parses the counts and the capped error list", () => {
    expect(
      ImportContactsResult.safeParse({
        imported: 2,
        updated: 1,
        skipped: 1,
        duplicates: 1,
        errors: [{ line: 4, email: "bad", reason: "invalid email" }],
      }).success,
    ).toBe(true);
  });
});

describe("UnsubscribeContactInput", () => {
  it("takes an address, an optional book and an optional reason", () => {
    expect(UnsubscribeContactInput.parse({ email: "A@B.io" })).toEqual({
      email: "a@b.io",
    });
    expect(UnsubscribeContactInput.safeParse({ email: "x" }).success).toBe(
      false,
    );
  });
});

describe("ContactObject", () => {
  it("parses what the REST layer returns", () => {
    expect(
      ContactObject.safeParse({
        id: "ct_1",
        bookId: "cb_1",
        email: "a@b.io",
        firstName: null,
        lastName: null,
        properties: {},
        subscribed: false,
        unsubscribeReason: "link",
        unsubscribedAt: "2026-08-26T00:00:00.000Z",
        createdAt: "2026-08-26T00:00:00.000Z",
        updatedAt: "2026-08-26T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && bunx vitest run tests/api-contacts.test.ts`
Expected: FAIL — nothing is exported from `../src/index`.

- [ ] **Step 3: Write `packages/shared/src/api/contacts.ts`**

```ts
import { z } from "zod";
import { PageQuery } from "./emails";

/**
 * Contracts for `/api/v1/contact-books` and `/api/v1/contacts` (spec §7).
 *
 * A contact's `subscribed` flag is **consent**, and it is not the suppression
 * list. Suppressions block every send to an address, transactional included,
 * and are written by SES bounce/complaint events; unsubscribing a contact says
 * "not this kind of mail" and blocks nothing in this phase — campaign
 * recipient selection (Phase 7) is what reads it. Nothing here writes a
 * suppression, and nothing in `services/suppressions.ts` writes a contact.
 */

const ADDR_SPEC = '[^\\s@<>"]+@[^\\s@<>"]+\\.[^\\s@<>"]+';
/** `"Name <a@b>"` or a bare address, matching `SendEmailInput`'s shape check. */
const FROM_RE = new RegExp(`^(?:[^<>]*<${ADDR_SPEC}>|${ADDR_SPEC})$`);

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .pipe(z.email("Enter a valid email."));

/** Up to 20 free-form string properties, 500 characters each. */
const properties = z
  .record(z.string().trim().min(1).max(64), z.string().max(500))
  .refine((p) => Object.keys(p).length <= 20, "At most 20 properties.");

export const CreateContactBookInput = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120),
  /** Suggested sender for campaigns from this book; not used for sending yet. */
  defaultFrom: z
    .string()
    .trim()
    .max(320)
    .regex(FROM_RE, "Enter a valid from-address.")
    .optional(),
});
export type CreateContactBookInput = z.infer<typeof CreateContactBookInput>;

export const UpdateContactBookInput = CreateContactBookInput.extend({
  defaultFrom: z
    .string()
    .trim()
    .max(320)
    .regex(FROM_RE, "Enter a valid from-address.")
    .nullable(),
})
  .partial()
  .refine((o) => Object.keys(o).length > 0, "Nothing to update.");
export type UpdateContactBookInput = z.infer<typeof UpdateContactBookInput>;

export const ContactBookObject = z.object({
  id: z.string(),
  name: z.string(),
  defaultFrom: z.string().nullable(),
  /** Contacts in the book, and how many of them are still subscribed. */
  contactCount: z.number().int(),
  subscribedCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ContactBookObject = z.infer<typeof ContactBookObject>;

export const CreateContactInput = z.object({
  email,
  firstName: z.string().trim().max(120).optional(),
  lastName: z.string().trim().max(120).optional(),
  properties: properties.default({}),
  subscribed: z.boolean().default(true),
});
export type CreateContactInput = z.infer<typeof CreateContactInput>;

export const UpdateContactInput = z
  .object({
    firstName: z.string().trim().max(120).nullable(),
    lastName: z.string().trim().max(120).nullable(),
    properties,
    subscribed: z.boolean(),
    /** Free text; the dashboard writes "manual", the API whatever the caller sends. */
    unsubscribeReason: z.string().trim().max(200).nullable(),
  })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "Nothing to update.");
export type UpdateContactInput = z.infer<typeof UpdateContactInput>;

export const ContactObject = z.object({
  id: z.string(),
  bookId: z.string(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  properties: z.record(z.string(), z.string()),
  subscribed: z.boolean(),
  unsubscribeReason: z.string().nullable(),
  unsubscribedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ContactObject = z.infer<typeof ContactObject>;

/** `?limit&cursor&q&subscribed`; `q` matches the address prefix or either name. */
export const ListContactsQuery = PageQuery.extend({
  q: z.string().trim().min(1).max(120).optional(),
  subscribed: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});
export type ListContactsQuery = z.infer<typeof ListContactsQuery>;

/** 2 MB of CSV text; bigger lists are imported in chunks (see `/docs/contacts`). */
export const MAX_IMPORT_CSV_CHARS = 2 * 1024 * 1024;

export const ImportContactsInput = z.object({
  csv: z
    .string()
    .min(1, "CSV is required.")
    .max(MAX_IMPORT_CSV_CHARS, "CSV is larger than 2 MB; import it in chunks."),
  /** False leaves an address that is already in the book exactly as it is. */
  updateExisting: z.boolean().default(true),
});
export type ImportContactsInput = z.infer<typeof ImportContactsInput>;

export const ImportContactsResult = z.object({
  imported: z.number().int(),
  updated: z.number().int(),
  /** Rows that were parsed but not applied (bad address, or already present). */
  skipped: z.number().int(),
  /** Rows dropped because a later row in the same file had the same address. */
  duplicates: z.number().int(),
  errors: z
    .array(
      z.object({
        line: z.number().int(),
        email: z.string().nullable(),
        reason: z.string(),
      }),
    )
    .max(100),
});
export type ImportContactsResult = z.infer<typeof ImportContactsResult>;

/**
 * `POST /contacts/unsubscribe` — by address, across **every book of the team**
 * unless `bookId` narrows it. The person said stop, not "stop for book A".
 */
export const UnsubscribeContactInput = z.object({
  email,
  bookId: z.string().trim().min(1).optional(),
  reason: z.string().trim().max(200).optional(),
});
export type UnsubscribeContactInput = z.infer<typeof UnsubscribeContactInput>;

export const UnsubscribeResult = z.object({
  /** Contact rows changed by this call; 0 when the address was already out. */
  unsubscribed: z.number().int(),
});
export type UnsubscribeResult = z.infer<typeof UnsubscribeResult>;
```

- [ ] **Step 4: Export it from the barrel**

In `packages/shared/src/index.ts`, add after `export * from "./api/templates";`:

```ts
export * from "./api/contacts";
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cd packages/shared && bunx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): contact book, contact and CSV import contracts"
```

---

## Task 4: Schema — `templates`, `template_versions`, `contact_books`, `contacts`, and two columns on `emails`

Four new tables plus the two columns `emails` has been missing since §5 of the spec (`template_id`, `variables`). `variables` joins `html`/`text` in the retention purge in the same task, because it holds whatever the caller substituted — names, order numbers, addresses — and a body-purged email that still carries its variables has not been purged.

**Files:**

- Create: `apps/web/src/db/schema/templates.ts`, `apps/web/src/db/schema/contacts.ts`, `apps/web/drizzle/0013_templates_contacts.sql`
- Modify: `apps/web/src/db/schema/index.ts`, `apps/web/src/db/schema/emails.ts`, `apps/web/src/services/retention.ts`, `apps/web/drizzle/meta/_journal.json`
- Test: `apps/web/tests/integration/templates-schema.test.ts`, `apps/web/tests/integration/retention.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

`apps/web/tests/integration/templates-schema.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

describe("templates and contacts schema", () => {
  it("templates are unique per team by slug and cascade with the team", async () => {
    const { db } = await import("@/db");
    const { organization, templates } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    const row = {
      id: "tpl_a",
      teamId: team.id,
      slug: "welcome",
      name: "Welcome",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
    };
    await db().insert(templates).values(row);
    await expect(
      db()
        .insert(templates)
        .values({ ...row, id: "tpl_b" }),
    ).rejects.toThrow();
    // The same slug in another team is a different template.
    const other = await seedTeamWithKey();
    await db()
      .insert(templates)
      .values({ ...row, id: "tpl_c", teamId: other.team.id });
    await db().delete(organization).where(eq(organization.id, team.id));
    expect(
      await db().select().from(templates).where(eq(templates.teamId, team.id)),
    ).toHaveLength(0);
  });

  it("template_versions are keyed on (template, version) and cascade with the template", async () => {
    const { db } = await import("@/db");
    const { templateVersions, templates } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await db().insert(templates).values({
      id: "tpl_v",
      teamId: team.id,
      slug: "v",
      name: "V",
      subject: "s",
      bodyHtml: "b",
    });
    const snapshot = {
      name: "V",
      subject: "s",
      bodyHtml: "b",
      bodyText: null,
      variablesSchema: { variables: [] },
    };
    await db()
      .insert(templateVersions)
      .values({ templateId: "tpl_v", version: 1, snapshot });
    await expect(
      db()
        .insert(templateVersions)
        .values({ templateId: "tpl_v", version: 1, snapshot }),
    ).rejects.toThrow();
    await db().delete(templates).where(eq(templates.id, "tpl_v"));
    expect(await db().select().from(templateVersions)).toHaveLength(0);
  });

  it("contacts are unique per (book, email) and cascade with the book", async () => {
    const { db } = await import("@/db");
    const { contactBooks, contacts } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await db()
      .insert(contactBooks)
      .values({ id: "cb_1", teamId: team.id, name: "News" });
    const row = {
      id: "ct_1",
      bookId: "cb_1",
      teamId: team.id,
      email: "a@b.io",
    };
    await db().insert(contacts).values(row);
    await expect(
      db()
        .insert(contacts)
        .values({ ...row, id: "ct_2" }),
    ).rejects.toThrow();
    await db().delete(contactBooks).where(eq(contactBooks.id, "cb_1"));
    expect(await db().select().from(contacts)).toHaveLength(0);
  });

  it("emails carry a template reference that survives deleting the template", async () => {
    const { db } = await import("@/db");
    const { domains, emails, templates } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await db().insert(templates).values({
      id: "tpl_e",
      teamId: team.id,
      slug: "e",
      name: "E",
      subject: "s",
      bodyHtml: "b",
    });
    await db()
      .insert(domains)
      .values({ id: "dom_e", teamId: team.id, name: `d${Date.now()}.io` });
    await db()
      .insert(emails)
      .values({
        id: "em_e",
        teamId: team.id,
        domainId: "dom_e",
        from: "a@b.io",
        fromEmail: "a@b.io",
        to: ["c@d.io"],
        subject: "s",
        templateId: "tpl_e",
        variables: { name: "Mingu" },
      });
    await db().delete(templates).where(eq(templates.id, "tpl_e"));
    const [row] = await db().select().from(emails).where(eq(emails.id, "em_e"));
    expect(row?.templateId).toBeNull();
    expect(row?.variables).toEqual({ name: "Mingu" });
  });

  // Migration 0011 exists because a µs/ms mismatch silently skipped rows; the
  // billing schema test guards the same thing. Every column below is either
  // keyset-paged or ordered against a value that has been through a JS `Date`.
  it("stores millisecond precision on the paged timestamps", async () => {
    const { sql } = await import("drizzle-orm");
    const rows = await pg.db.execute(
      sql`select table_name, column_name, datetime_precision
          from information_schema.columns
          where table_schema = 'public'
            and (table_name, column_name) in (
              ('templates', 'created_at'),
              ('template_versions', 'created_at'),
              ('contact_books', 'created_at'),
              ('contacts', 'created_at')
            )
          order by table_name, column_name`,
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.datetime_precision).toBe(3);
  });
});
```

Append to `apps/web/tests/integration/retention.test.ts` (inside the existing top-level `describe`; it already seeds emails and calls `purgeOldBodies` — reuse whatever helper that file has for an old email, and set `variables` on it):

```ts
it("purges the substituted variables along with the body", async () => {
  const { db } = await import("@/db");
  const { emails } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { purgeOldBodies } = await import("@/services/retention");
  const { team } = await seedTeamWithKey();
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);
  await db()
    .insert(emails)
    .values({
      id: "em_vars",
      teamId: team.id,
      from: "a@b.io",
      fromEmail: "a@b.io",
      to: ["c@d.io"],
      subject: "s",
      html: "<p>hi</p>",
      variables: { name: "Mingu", orderId: "1234" },
      createdAt: old,
    });
  await purgeOldBodies(90, new Date());
  const [row] = await db()
    .select()
    .from(emails)
    .where(eq(emails.id, "em_vars"));
  expect(row?.html).toBeNull();
  // Variables hold whatever was substituted — names, order numbers,
  // addresses. A row whose body is gone but whose variables remain has not
  // been purged.
  expect(row?.variables).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/templates-schema.test.ts`
Expected: FAIL — `templates` / `templateVersions` / `contactBooks` / `contacts` are not exported from `@/db/schema`.

- [ ] **Step 3: Write `apps/web/src/db/schema/templates.ts`**

```ts
import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { TemplateVariablesSchema } from "@sendsprite/shared";
import { organization } from "./auth";

/** The current state of a template. Its history is `template_versions`. */
export const templates = pgTable(
  "templates",
  {
    id: text("id").primaryKey(), // tpl_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** URL key and the name `POST /emails` uses in `template`. Unique per team. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    bodyText: text("body_text"),
    variablesSchema: jsonb("variables_schema")
      .$type<TemplateVariablesSchema>()
      .notNull()
      .default({ variables: [] }),
    /** Bumped on every content change; matches the newest `template_versions` row. */
    version: integer("version").notNull().default(1),
    updatedBy: text("updated_by"),
    // Millisecond precision: the list cursor round-trips `createdAt` through
    // a JS Date (ms); see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [uniqueIndex("templates_team_slug_uidx").on(t.teamId, t.slug)],
);
export type Template = typeof templates.$inferSelect;

export interface TemplateSnapshot {
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variablesSchema: TemplateVariablesSchema;
}

/**
 * One row per version, holding the template **as it became** at that version —
 * so the newest row always equals the `templates` row and the history is
 * complete on its own. Restoring a version is an ordinary update carrying an
 * old snapshot's fields, which then writes a new version of its own: history
 * is append-only and a restore is visible as one.
 *
 * No surrogate id: `(template_id, version)` is the identity, the way
 * `billing_usage` is keyed on `(team_id, period_start)`.
 */
export const templateVersions = pgTable(
  "template_versions",
  {
    templateId: text("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").$type<TemplateSnapshot>().notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.version] })],
);
export type TemplateVersion = typeof templateVersions.$inferSelect;
```

- [ ] **Step 4: Write `apps/web/src/db/schema/contacts.ts`**

```ts
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

/** A named audience. Contacts live in exactly one book. */
export const contactBooks = pgTable(
  "contact_books",
  {
    id: text("id").primaryKey(), // cb_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Suggested sender for campaigns from this book (Phase 7); unused for now. */
    defaultFrom: text("default_from"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("contact_books_team_created_idx").on(t.teamId, t.createdAt)],
);
export type ContactBook = typeof contactBooks.$inferSelect;

/**
 * One person in one book. `subscribed` is **consent**, not deliverability:
 * `suppressions` is what stops a send, and nothing here writes it. See
 * `services/contacts.ts` and `packages/shared/src/api/contacts.ts`.
 *
 * `teamId` is denormalised from the book on purpose: `POST /contacts/
 * unsubscribe` is by address across the whole team, and the REST layer
 * authorises a contact against the calling key's team. Both would otherwise be
 * a join on every request, and the FK to the book keeps the two consistent.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: text("id").primaryKey(), // ct_<ulid>
    bookId: text("book_id")
      .notNull()
      .references(() => contactBooks.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // normalised
    firstName: text("first_name"),
    lastName: text("last_name"),
    properties: jsonb("properties")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    subscribed: boolean("subscribed").notNull().default(true),
    unsubscribeReason: text("unsubscribe_reason"),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("contacts_book_email_uidx").on(t.bookId, t.email),
    // The team-wide unsubscribe reads by (team, email).
    index("contacts_team_email_idx").on(t.teamId, t.email),
    index("contacts_book_created_idx").on(t.bookId, t.createdAt),
  ],
);
export type Contact = typeof contacts.$inferSelect;
```

- [ ] **Step 5: Add the two columns to `emails` and export the new tables**

In `apps/web/src/db/schema/emails.ts`, add these two fields directly after `attachmentsMeta`:

```ts
    // Nullable and `set null`: the mail log must never block deleting a
    // template, exactly as it must never block deleting a domain.
    templateId: text("template_id").references(() => templates.id, {
      onDelete: "set null",
    }),
    /**
     * The variables that produced this email's body. Kept for debugging and
     * for "resend"; purged with the body by retention, because they hold
     * whatever the caller substituted (names, order numbers, addresses).
     */
    variables: jsonb("variables").$type<Record<string, unknown>>(),
```

and add the import at the top of the same file:

```ts
import { templates } from "./templates";
```

In `apps/web/src/db/schema/index.ts`, add after `export * from "./suppressions";`:

```ts
export * from "./templates";
export * from "./contacts";
```

Order matters for nothing at runtime, but `emails.ts` now imports `templates.ts`, so keep `./templates` exported before anything that might later depend on it.

- [ ] **Step 6: Purge `variables` with the body**

In `apps/web/src/services/retention.ts`, change the purge update — the existing line is `.set({ html: null, text: null, bodyPurgedAt: now })`:

```ts
        // `variables` holds whatever the caller substituted into the body, so
        // it is body content and is purged with it.
        .set({ html: null, text: null, variables: null, bodyPurgedAt: now })
```

and extend the doc comment at the top of the file so it reads `html`/`text`/`variables` nulled.

- [ ] **Step 7: Generate and rename the migration**

Run: `cd apps/web && bun run db:generate`

Rename the generated `apps/web/drizzle/00NN_<random>.sql` to `apps/web/drizzle/0013_templates_contacts.sql` and change the matching entry's `tag` in `apps/web/drizzle/meta/_journal.json` from `00NN_<random>` to `0013_templates_contacts` (the 0009–0012 precedent). Read the SQL and confirm it contains exactly:

- `CREATE TABLE "templates"`, `CREATE TABLE "template_versions"` (with `PRIMARY KEY("template_id","version")`), `CREATE TABLE "contact_books"`, `CREATE TABLE "contacts"`;
- `ALTER TABLE "emails" ADD COLUMN "template_id" text` and `ADD COLUMN "variables" jsonb`;
- foreign keys: `templates.team_id`, `contact_books.team_id`, `contacts.team_id` and `contacts.book_id` all `ON DELETE cascade`; `template_versions.template_id` `ON DELETE cascade`; `emails.template_id` `ON DELETE set null`;
- `CREATE UNIQUE INDEX "templates_team_slug_uidx"`, `CREATE UNIQUE INDEX "contacts_book_email_uidx"`, and the three plain indexes;
- **every `timestamp(3) with time zone`** on the four `created_at` columns. If drizzle-kit emitted plain `timestamp with time zone` for any of them, fix the schema file rather than the SQL and regenerate — the guard test in Step 1 is what catches it.

It must not touch any other existing table.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/templates-schema.test.ts tests/integration/retention.test.ts`
Expected: PASS (5 new tests plus retention's existing ones).

- [ ] **Step 9: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add apps/web/src/db apps/web/src/services/retention.ts apps/web/drizzle apps/web/tests
git commit -m "feat(db): templates, template_versions, contact_books and contacts tables"
```

---

## Task 5: The CSV parser, serialiser and injection guard

Untrusted input at volume gets its own module and its own unit tests, with no database in the way. Written before the import service so the parser's edge cases are settled before anything writes rows.

**Files:**

- Create: `apps/web/src/lib/csv.ts`
- Test: `apps/web/tests/unit/csv.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/tests/unit/csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_CSV_ROWS, csvCell, parseCsv, toCsv } from "@/lib/csv";

const ok = (text: string) => {
  const r = parseCsv(text);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  return r.data;
};

describe("parseCsv", () => {
  it("reads a header and rows, tolerating CRLF, a BOM and a trailing newline", () => {
    const p = ok("﻿email,first_name\r\na@b.io,Ada\r\nc@d.io,Grace\r\n");
    expect(p.header).toEqual(["email", "first_name"]);
    expect(p.rows).toEqual([
      { line: 2, cells: ["a@b.io", "Ada"] },
      { line: 3, cells: ["c@d.io", "Grace"] },
    ]);
  });

  it("handles quoted fields with commas, newlines and doubled quotes", () => {
    const p = ok('a,b\n"x,1","he said ""hi""\nagain"\n');
    expect(p.rows[0]!.cells).toEqual(["x,1", 'he said "hi"\nagain']);
    // The embedded newline does not advance the reported line number of the
    // *next* row past the physical lines it consumed.
    expect(p.rows).toHaveLength(1);
  });

  it("keeps empty cells and does not trim inside quotes", () => {
    const p = ok('a,b,c\n1,, " x "\n');
    expect(p.rows[0]!.cells).toEqual(["1", "", " x "]);
  });

  it("refuses an unterminated quote — after it nothing can be trusted", () => {
    const r = parseCsv('a\n"never closed\n');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/unterminated/i);
  });

  it("refuses an empty document and a header-only document is zero rows", () => {
    expect(parseCsv("").ok).toBe(false);
    expect(ok("email\n").rows).toEqual([]);
  });

  it("refuses more than MAX_CSV_ROWS data rows", () => {
    const text = [
      "email",
      ...Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => `a${i}@b.io`),
    ].join("\n");
    const r = parseCsv(text);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(new RegExp(String(MAX_CSV_ROWS)));
  });

  it("pads a short row and reports an over-long one rather than silently shifting columns", () => {
    const p = ok("a,b,c\n1,2\n");
    expect(p.rows[0]!.cells).toEqual(["1", "2", ""]);
    const r = parseCsv("a,b\n1,2,3\n");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/line 2/);
  });
});

describe("csvCell", () => {
  it("neutralises formula injection on the four dangerous leaders", () => {
    for (const [raw, want] of [
      ["=1+1", "'=1+1"],
      ["+1", "'+1"],
      ["-1", "'-1"],
      ["@SUM(A1)", "'@SUM(A1)"],
      ["\tx", "'\tx"],
    ] as const)
      expect(csvCell(raw)).toBe(want);
  });

  it("quotes anything containing a quote, a comma or a newline", () => {
    expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });

  it("leaves an ordinary value alone", () => {
    expect(csvCell("ada@b.io")).toBe("ada@b.io");
    expect(csvCell("")).toBe("");
  });

  it("quotes *and* prefixes a value that is both dangerous and needs quoting", () => {
    expect(csvCell('=cmd|"/c calc"!A0')).toBe(`"'=cmd|""/c calc""!A0"`);
  });
});

describe("toCsv", () => {
  it("round-trips through parseCsv", () => {
    const text = toCsv(["email", "note"], [["a@b.io", 'x,"y"']]);
    expect(ok(text).rows[0]!.cells).toEqual(["a@b.io", 'x,"y"']);
  });

  it("ends with a newline so appending is safe", () => {
    expect(toCsv(["a"], [["1"]])).toBe("a\n1\n");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/csv.test.ts`
Expected: FAIL — `@/lib/csv` does not exist.

- [ ] **Step 3: Write `apps/web/src/lib/csv.ts`**

```ts
/**
 * RFC 4180 CSV, hand-written.
 *
 * Import is untrusted input at volume, so the parser is bounded on every axis
 * (bytes, rows, columns, cell length) and its failures are per-row where a row
 * can fail alone. The one fatal case is an unterminated quote: after it, the
 * meaning of every following line is unknowable, so continuing would import
 * garbage silently.
 *
 * Export is the other half of the threat model: a cell that a spreadsheet
 * would evaluate as a formula is neutralised by `csvCell`.
 */

/** Matches `ImportContactsInput.csv`'s bound in `@sendsprite/shared`. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 10_000;
export const MAX_CSV_COLUMNS = 24;
export const MAX_CSV_CELL_CHARS = 500;

export interface CsvRow {
  /** 1-based physical line the row started on, for error messages. */
  line: number;
  cells: string[];
}
export interface CsvDocument {
  header: string[];
  rows: CsvRow[];
}
export type CsvParseResult =
  { ok: true; data: CsvDocument } | { ok: false; error: string };

const fail = (error: string): CsvParseResult => ({ ok: false, error });

/**
 * Splits the whole document into records of cells in one pass. Returns the
 * physical start line of each record so an embedded newline does not make
 * every later error message point at the wrong line.
 */
function records(text: string): { line: number; cells: string[] }[] | string {
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let started = false;

  const endCell = () => {
    cells.push(cell);
    cell = "";
  };
  const endRecord = () => {
    endCell();
    out.push({ line: recordLine, cells });
    cells = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (!started) {
      recordLine = line;
      started = true;
    }
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === "\n") line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
      continue;
    }
    if (c === ",") {
      endCell();
      continue;
    }
    if (c === "\r") continue; // CRLF: the \n does the work
    if (c === "\n") {
      endRecord();
      line++;
      continue;
    }
    cell += c;
  }
  if (quoted) return `Unterminated quote starting at line ${recordLine}.`;
  // A document not ending in a newline still has a final record.
  if (started || cell !== "" || cells.length) endRecord();
  return out;
}

/**
 * Parses a CSV document with a header row. Short rows are padded to the header
 * width; a row **wider** than the header is fatal for that document, because a
 * stray comma silently shifts every value one column left and lands somebody
 * else's data in the wrong field.
 */
export function parseCsv(text: string): CsvParseResult {
  if (Buffer.byteLength(text) > MAX_CSV_BYTES)
    return fail(`CSV must be at most ${MAX_CSV_BYTES} bytes.`);
  // Excel writes a UTF-8 BOM; it would otherwise become part of the first header.
  const parsed = records(text.replace(/^﻿/, ""));
  if (typeof parsed === "string") return fail(parsed);
  const [head, ...rest] = parsed;
  if (!head || head.cells.every((c) => c.trim() === ""))
    return fail("CSV must start with a header row.");
  const header = head.cells.map((h) => h.trim());
  if (header.length > MAX_CSV_COLUMNS)
    return fail(`CSV must have at most ${MAX_CSV_COLUMNS} columns.`);
  // A file ending in a newline produces one trailing empty record.
  const body = rest.filter((r) => !(r.cells.length === 1 && r.cells[0] === ""));
  if (body.length > MAX_CSV_ROWS)
    return fail(`CSV must have at most ${MAX_CSV_ROWS} rows.`);
  const rows: CsvRow[] = [];
  for (const r of body) {
    if (r.cells.length > header.length)
      return fail(
        `Line ${r.line} has ${r.cells.length} values but the header has ${header.length}.`,
      );
    rows.push({
      line: r.line,
      cells: Array.from({ length: header.length }, (_, i) => r.cells[i] ?? ""),
    });
  }
  return { ok: true, data: { header, rows } };
}

/** Leaders a spreadsheet treats as the start of a formula (OWASP CSV injection). */
const FORMULA_LEADER = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /["\n\r,]/;

/**
 * One cell, safe to hand to a spreadsheet.
 *
 * A value beginning `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` so Excel
 * and Sheets treat it as text rather than executing it — an exported contact
 * whose "first name" is `=HYPERLINK(...)` must not become a live formula in the
 * customer's spreadsheet. Quoting is then applied on top, so a value that is
 * both dangerous and contains a comma gets both treatments.
 */
export function csvCell(value: string): string {
  const escaped = FORMULA_LEADER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(escaped)
    ? `"${escaped.replace(/"/g, '""')}"`
    : escaped;
}

/** A whole document, header first, always ending in a newline. */
export const toCsv = (
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string =>
  [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/csv.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add apps/web/src/lib/csv.ts apps/web/tests/unit/csv.test.ts
git commit -m "feat(web): bounded CSV parser with formula-injection-safe export"
```

---

## Task 6: The templates service

CRUD plus version history plus a render entry point, in the shape `services/suppressions.ts` established: a `can()` gate, `Result<T>` out, `recordAudit` on every mutation, `keysetPage` for the REST page.

**Permissions.** All four mutations require `templates.manage`, which the roles table grants to members — a member who may send may author what is sent. Deleting is not escalated to admin because a template is versioned and a delete is auditable, unlike removing a suppression (which un-blocks an address SES already refused).

**Files:**

- Create: `apps/web/src/services/templates.ts`
- Test: `apps/web/tests/integration/templates.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/tests/integration/templates.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

const draft = {
  slug: "welcome",
  name: "Welcome",
  subject: "Hi {{name}}",
  bodyHtml: "<p>Hello {{name}}</p>",
  bodyText: "Hello {{name}}",
};

describe("templates service", () => {
  it("creates at version 1 and records the first version snapshot", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    const created = await svc.createTemplate(actor, draft);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.data.id).toMatch(/^tpl_/);
    expect(created.data.version).toBe(1);
    const versions = await svc.listTemplateVersions(actor.teamId, "welcome");
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(versions[0]!.snapshot.subject).toBe("Hi {{name}}");
  });

  it("refuses a duplicate slug in the same team with `conflict`", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    expect((await svc.createTemplate(actor, draft)).ok).toBe(true);
    const again = await svc.createTemplate(actor, draft);
    expect(again).toMatchObject({ ok: false, code: "conflict" });
  });

  it("bumps the version and appends a snapshot only when content changed", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    const same = await svc.updateTemplate(actor, "welcome", {
      name: "Welcome",
    });
    if (!same.ok) throw new Error("unreachable");
    expect(same.data.version).toBe(1); // nothing actually changed
    const changed = await svc.updateTemplate(actor, "welcome", {
      bodyHtml: "<p>Hey {{name}}</p>",
    });
    if (!changed.ok) throw new Error("unreachable");
    expect(changed.data.version).toBe(2);
    const versions = await svc.listTemplateVersions(actor.teamId, "welcome");
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    // Newest first, and the newest snapshot equals the live row.
    expect(versions[0]!.snapshot.bodyHtml).toBe("<p>Hey {{name}}</p>");
  });

  it("looks a template up by slug or by id, scoped to the team", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    const created = await svc.createTemplate(actor, draft);
    if (!created.ok) throw new Error("unreachable");
    expect((await svc.getTemplate(actor.teamId, "welcome"))?.id).toBe(
      created.data.id,
    );
    expect((await svc.getTemplate(actor.teamId, created.data.id))?.slug).toBe(
      "welcome",
    );
    const other = await seedTeamWithKey();
    expect(await svc.getTemplate(other.actor.teamId, "welcome")).toBeNull();
  });

  it("renders a stored template, and refuses one whose variables are missing", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    const ok = await svc.renderStoredTemplate(actor.teamId, "welcome", {
      name: "<Mingu>",
    });
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.data).toEqual({
      subject: "Hi <Mingu>",
      html: "<p>Hello &lt;Mingu&gt;</p>",
      text: "Hello <Mingu>",
    });
    const bad = await svc.renderStoredTemplate(actor.teamId, "welcome", {});
    expect(bad).toMatchObject({ ok: false, code: "validation_error" });
    if (bad.ok) throw new Error("unreachable");
    expect(bad.details).toMatchObject({
      field: "variables",
      missing: ["name"],
    });
    const gone = await svc.renderStoredTemplate(actor.teamId, "nope", {});
    expect(gone).toMatchObject({ ok: false, code: "not_found" });
  });

  it("deletes, and reports not_found for an unknown slug", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    expect((await svc.deleteTemplate(actor, "welcome")).ok).toBe(true);
    expect(await svc.getTemplate(actor.teamId, "welcome")).toBeNull();
    expect(await svc.deleteTemplate(actor, "welcome")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("refuses every mutation for a role without templates.manage", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    // No role in the table lacks `templates.manage`, so this pins the gate
    // itself rather than a role: an actor with an unknown role is refused.
    const outsider = { ...actor, role: "viewer" as never };
    expect(await svc.createTemplate(outsider, draft)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });

  it("writes an audit row for create, update and delete", async () => {
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq, like } = await import("drizzle-orm");
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    await svc.updateTemplate(actor, "welcome", { name: "Welcome!" });
    await svc.deleteTemplate(actor, "welcome");
    const rows = await db()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.teamId, actor.teamId),
          like(auditLog.action, "templates.%"),
        ),
      );
    expect(rows.map((r) => r.action).sort()).toEqual([
      "templates.create",
      "templates.delete",
      "templates.update",
    ]);
  });

  it("pages the list newest first", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    for (const slug of ["a", "b", "c"])
      await svc.createTemplate(actor, { ...draft, slug });
    const page = await svc.listTemplatesPage(actor.teamId, { limit: 2 });
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.data).toHaveLength(2);
    expect(page.data.nextCursor).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/templates.test.ts`
Expected: FAIL — `@/services/templates` does not exist.

- [ ] **Step 3: Write `apps/web/src/services/templates.ts`**

```ts
import { and, desc, eq, or } from "drizzle-orm";
import {
  CreateTemplateInput,
  UpdateTemplateInput,
  can,
  newId,
  renderTemplate,
  type PageQuery,
  type RenderedTemplate,
} from "@sendsprite/shared";
import { db } from "@/db";
import { keysetPage, type Page } from "@/db/keyset";
import {
  templateVersions,
  templates,
  type Template,
  type TemplateSnapshot,
} from "@/db/schema";
import { computeDiff, recordAudit } from "@/lib/audit";
import type { Result } from "@/lib/result";
import type { TeamActor } from "./team";

export type { Template, TemplateSnapshot };

const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You don't have permission to do that.",
};
const NOT_FOUND: Result<never> = {
  ok: false,
  code: "not_found",
  error: "Template not found.",
};

/** Version history kept per template. Older entries stay in the table. */
export const VERSION_PAGE = 20;

/** REST shape: no team id. */
export const publicTemplate = (t: Template) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  subject: t.subject,
  bodyHtml: t.bodyHtml,
  bodyText: t.bodyText,
  variablesSchema: t.variablesSchema,
  version: t.version,
  updatedBy: t.updatedBy,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

export const publicTemplateVersion = (
  v: typeof templateVersions.$inferSelect,
) => ({
  version: v.version,
  snapshot: v.snapshot,
  createdBy: v.createdBy,
  createdAt: v.createdAt,
});

/** Newest first (the dashboard list). */
export const listTemplates = (teamId: string): Promise<Template[]> =>
  db()
    .select()
    .from(templates)
    .where(eq(templates.teamId, teamId))
    .orderBy(desc(templates.createdAt));

/** REST page, newest first; keyset paging on `(created_at, id)`. */
export const listTemplatesPage = (
  teamId: string,
  q: PageQuery,
): Promise<Result<Page<Template>>> =>
  keysetPage(templates, q, eq(templates.teamId, teamId));

/**
 * By slug **or** by id. The REST path segment is the slug (spec §7), but an
 * id is what the dashboard and the SDK have in hand after a create, and
 * accepting both costs one `or`.
 */
export async function getTemplate(
  teamId: string,
  key: string,
): Promise<Template | null> {
  const k = key.trim();
  if (!k) return null;
  const [row] = await db()
    .select()
    .from(templates)
    .where(
      and(
        eq(templates.teamId, teamId),
        or(eq(templates.slug, k.toLowerCase()), eq(templates.id, k)),
      ),
    );
  return row ?? null;
}

export async function listTemplateVersions(
  teamId: string,
  key: string,
  limit = VERSION_PAGE,
): Promise<(typeof templateVersions.$inferSelect)[]> {
  const t = await getTemplate(teamId, key);
  if (!t) return [];
  return db()
    .select()
    .from(templateVersions)
    .where(eq(templateVersions.templateId, t.id))
    .orderBy(desc(templateVersions.version))
    .limit(limit);
}

const snapshotOf = (t: {
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  variablesSchema: Template["variablesSchema"];
}): TemplateSnapshot => ({
  name: t.name,
  subject: t.subject,
  bodyHtml: t.bodyHtml,
  bodyText: t.bodyText,
  variablesSchema: t.variablesSchema,
});

export async function createTemplate(
  actor: TeamActor,
  raw: unknown,
): Promise<Result<Template>> {
  if (!can(actor.role, "templates.manage")) return DENIED;
  const p = CreateTemplateInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const id = newId("tpl");
  const values = {
    id,
    teamId: actor.teamId,
    slug: p.data.slug,
    name: p.data.name,
    subject: p.data.subject,
    bodyHtml: p.data.bodyHtml,
    bodyText: p.data.bodyText ?? null,
    variablesSchema: p.data.variablesSchema,
    version: 1,
    updatedBy: actor.userId,
  };
  let row: Template | undefined;
  try {
    row = await db().transaction(async (tx) => {
      const [t] = await tx.insert(templates).values(values).returning();
      if (!t) throw new Error("templates insert returned no row");
      await tx.insert(templateVersions).values({
        templateId: t.id,
        version: 1,
        snapshot: snapshotOf(t),
        createdBy: actor.userId,
      });
      return t;
    });
  } catch (e) {
    if (pgCode(e) === "23505")
      return {
        ok: false,
        code: "conflict",
        error: `A template with the slug "${p.data.slug}" already exists.`,
      };
    throw e;
  }
  if (!row) throw new Error("templates insert returned no row");
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "templates.create",
    targetType: "template",
    targetId: row.slug,
    diff: { slug: { to: row.slug }, name: { to: row.name } },
  });
  return { ok: true, data: row };
}

/**
 * A content change bumps `version` and appends a snapshot; a no-op update
 * (same values, or `name` alone re-submitted unchanged) does neither, so the
 * history is a record of real edits rather than of save clicks.
 *
 * `slug` cannot be changed: a live `POST /emails` names a template by slug, so
 * a rename is a silent outage. Renaming is create-then-delete.
 */
export async function updateTemplate(
  actor: TeamActor,
  key: string,
  raw: unknown,
): Promise<Result<Template>> {
  if (!can(actor.role, "templates.manage")) return DENIED;
  const p = UpdateTemplateInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const current = await getTemplate(actor.teamId, key);
  if (!current) return NOT_FOUND;
  const next = {
    name: p.data.name ?? current.name,
    subject: p.data.subject ?? current.subject,
    bodyHtml: p.data.bodyHtml ?? current.bodyHtml,
    bodyText:
      p.data.bodyText === undefined ? current.bodyText : p.data.bodyText,
    variablesSchema: p.data.variablesSchema ?? current.variablesSchema,
  };
  const before = snapshotOf(current);
  const after = snapshotOf(next);
  const diff = computeDiff(
    before as unknown as Record<string, unknown>,
    after as unknown as Record<string, unknown>,
  );
  if (!diff) return { ok: true, data: current };
  const version = current.version + 1;
  const row = await db().transaction(async (tx) => {
    const [t] = await tx
      .update(templates)
      .set({ ...next, version, updatedBy: actor.userId, updatedAt: new Date() })
      .where(eq(templates.id, current.id))
      .returning();
    if (!t) throw new Error("templates update returned no row");
    await tx.insert(templateVersions).values({
      templateId: t.id,
      version,
      snapshot: after,
      createdBy: actor.userId,
    });
    return t;
  });
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "templates.update",
    targetType: "template",
    targetId: row.slug,
    // Bodies can be megabytes; the audit row records *which* fields moved and
    // to what version, not the content. The snapshots are the content.
    diff: {
      fields: { to: Object.keys(diff).join(", ") },
      version: { from: current.version, to: version },
    },
  });
  return { ok: true, data: row };
}

export async function deleteTemplate(
  actor: TeamActor,
  key: string,
): Promise<Result> {
  if (!can(actor.role, "templates.manage")) return DENIED;
  const current = await getTemplate(actor.teamId, key);
  if (!current) return NOT_FOUND;
  // `template_versions` cascades; `emails.template_id` is `set null`, so the
  // mail log keeps every message that was sent from it.
  await db().delete(templates).where(eq(templates.id, current.id));
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "templates.delete",
    targetType: "template",
    targetId: current.slug,
    diff: { version: { from: current.version } },
  });
  return { ok: true, data: undefined };
}

/**
 * Renders a stored template without sending or storing anything — the
 * `POST /:slug/render` endpoint and the send path both come through here, so
 * a preview cannot differ from what is sent.
 */
export async function renderStoredTemplate(
  teamId: string,
  key: string,
  variables: Record<string, unknown>,
): Promise<Result<RenderedTemplate>> {
  const t = await getTemplate(teamId, key);
  if (!t) return NOT_FOUND;
  const r = renderTemplate(
    { subject: t.subject, bodyHtml: t.bodyHtml, bodyText: t.bodyText },
    variables,
    t.variablesSchema,
  );
  if (!r.ok)
    return {
      ok: false,
      code: "validation_error",
      error: r.error,
      details: { field: "variables", missing: r.missing, invalid: r.invalid },
    };
  return { ok: true, data: r.data };
}

/** Postgres SQLSTATE, on the driver error or (drizzle) its `cause`. */
const pgCode = (e: unknown): string | undefined => {
  const o = e as { code?: string; cause?: { code?: string } } | null;
  return o?.code ?? o?.cause?.code;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/templates.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add apps/web/src/services/templates.ts apps/web/tests/integration/templates.test.ts
git commit -m "feat(templates): versioned template CRUD and the render entry point"
```

---

## Task 7: The contacts service

Books, contacts, CSV import and the team-wide unsubscribe. `contact.*` webhook events start firing here — the `/docs/webhooks` table stops saying "reserved" in Task 16.

**Permissions.** `contacts.manage` (members and up) for every mutation, **except deleting a book**, which additionally needs `settings.manage`: it cascades an entire audience away in one statement and there is no version history to restore it from.

**Files:**

- Create: `apps/web/src/services/contacts.ts`
- Test: `apps/web/tests/integration/contacts.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/tests/integration/contacts.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

/** Contacts fan out webhook events; nothing here needs them delivered. */
const deps = { enqueue: async () => "job" };

async function book(name = "News") {
  const svc = await import("@/services/contacts");
  const { actor } = await seedTeamWithKey();
  const created = await svc.createBook(actor, { name });
  if (!created.ok) throw new Error("seed failed");
  return { actor, book: created.data, svc };
}

describe("contact books", () => {
  it("creates, lists with counts, updates and deletes", async () => {
    const { actor, book: b, svc } = await book();
    await svc.createContact(actor, b.id, { email: "a@b.io" }, deps);
    await svc.createContact(
      actor,
      b.id,
      { email: "c@d.io", subscribed: false },
      deps,
    );
    const [listed] = await svc.listBooks(actor.teamId);
    expect(listed).toMatchObject({
      id: b.id,
      contactCount: 2,
      subscribedCount: 1,
    });
    const renamed = await svc.updateBook(actor, b.id, { name: "Newsletter" });
    expect(renamed).toMatchObject({ ok: true });
    expect((await svc.deleteBook(actor, b.id)).ok).toBe(true);
    expect(await svc.listBooks(actor.teamId)).toEqual([]);
  });

  it("refuses a book from another team", async () => {
    const { book: b, svc } = await book();
    const other = await seedTeamWithKey();
    expect(
      await svc.updateBook(other.actor, b.id, { name: "x" }),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("needs settings.manage to delete a book", async () => {
    const { actor, book: b, svc } = await book();
    const member = { ...actor, role: "member" as const };
    expect(await svc.deleteBook(member, b.id)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
  });
});

describe("contacts", () => {
  it("normalises the address and refuses a duplicate in the same book", async () => {
    const { actor, book: b, svc } = await book();
    const c = await svc.createContact(actor, b.id, { email: " A@B.IO " }, deps);
    if (!c.ok) throw new Error("unreachable");
    expect(c.data.email).toBe("a@b.io");
    expect(
      await svc.createContact(actor, b.id, { email: "a@b.io" }, deps),
    ).toMatchObject({ ok: false, code: "conflict" });
  });

  it("searches by address prefix and by name, and filters by subscription", async () => {
    const { actor, book: b, svc } = await book();
    await svc.createContact(
      actor,
      b.id,
      { email: "ada@b.io", firstName: "Ada" },
      deps,
    );
    await svc.createContact(
      actor,
      b.id,
      { email: "grace@b.io", firstName: "Grace", subscribed: false },
      deps,
    );
    const byQ = await svc.listContactsPage(actor.teamId, b.id, {
      limit: 25,
      q: "ada",
    });
    if (!byQ.ok) throw new Error("unreachable");
    expect(byQ.data.data.map((c) => c.email)).toEqual(["ada@b.io"]);
    const byName = await svc.listContactsPage(actor.teamId, b.id, {
      limit: 25,
      q: "grac",
    });
    if (!byName.ok) throw new Error("unreachable");
    expect(byName.data.data.map((c) => c.email)).toEqual(["grace@b.io"]);
    const subscribed = await svc.listContactsPage(actor.teamId, b.id, {
      limit: 25,
      subscribed: true,
    });
    if (!subscribed.ok) throw new Error("unreachable");
    expect(subscribed.data.data.map((c) => c.email)).toEqual(["ada@b.io"]);
  });

  it("records unsubscribedAt on the way out and clears it on the way back in", async () => {
    const { actor, book: b, svc } = await book();
    const c = await svc.createContact(actor, b.id, { email: "a@b.io" }, deps);
    if (!c.ok) throw new Error("unreachable");
    const out = await svc.updateContact(
      actor,
      b.id,
      c.data.id,
      { subscribed: false, unsubscribeReason: "manual" },
      deps,
    );
    if (!out.ok) throw new Error("unreachable");
    expect(out.data.unsubscribedAt).toBeInstanceOf(Date);
    const back = await svc.updateContact(
      actor,
      b.id,
      c.data.id,
      { subscribed: true },
      deps,
    );
    if (!back.ok) throw new Error("unreachable");
    expect(back.data.unsubscribedAt).toBeNull();
    expect(back.data.unsubscribeReason).toBeNull();
  });
});

describe("unsubscribe", () => {
  it("unsubscribes the address across every book of the team", async () => {
    const svc = await import("@/services/contacts");
    const { actor } = await seedTeamWithKey();
    const one = await svc.createBook(actor, { name: "One" });
    const two = await svc.createBook(actor, { name: "Two" });
    if (!one.ok || !two.ok) throw new Error("seed failed");
    await svc.createContact(actor, one.data.id, { email: "a@b.io" }, deps);
    await svc.createContact(actor, two.data.id, { email: "A@B.io" }, deps);
    const r = await svc.unsubscribeContact(actor, { email: "a@b.io" }, deps);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.unsubscribed).toBe(2);
    // Idempotent: nothing left to change.
    const again = await svc.unsubscribeContact(
      actor,
      { email: "a@b.io" },
      deps,
    );
    if (!again.ok) throw new Error("unreachable");
    expect(again.data.unsubscribed).toBe(0);
  });

  it("narrows to one book when asked", async () => {
    const svc = await import("@/services/contacts");
    const { actor } = await seedTeamWithKey();
    const one = await svc.createBook(actor, { name: "One" });
    const two = await svc.createBook(actor, { name: "Two" });
    if (!one.ok || !two.ok) throw new Error("seed failed");
    await svc.createContact(actor, one.data.id, { email: "a@b.io" }, deps);
    await svc.createContact(actor, two.data.id, { email: "a@b.io" }, deps);
    const r = await svc.unsubscribeContact(
      actor,
      { email: "a@b.io", bookId: one.data.id },
      deps,
    );
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.unsubscribed).toBe(1);
  });

  it("writes NO suppression row — consent is not deliverability", async () => {
    const { db } = await import("@/db");
    const { suppressions } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { actor, book: b, svc } = await book();
    await svc.createContact(actor, b.id, { email: "a@b.io" }, deps);
    await svc.unsubscribeContact(actor, { email: "a@b.io" }, deps);
    expect(
      await db()
        .select()
        .from(suppressions)
        .where(eq(suppressions.teamId, actor.teamId)),
    ).toEqual([]);
  });

  it("does not touch a contact of another team with the same address", async () => {
    const { actor, book: b, svc } = await book();
    const other = await book();
    await svc.createContact(actor, b.id, { email: "a@b.io" }, deps);
    await other.svc.createContact(
      other.actor,
      other.book.id,
      { email: "a@b.io" },
      deps,
    );
    await svc.unsubscribeContact(actor, { email: "a@b.io" }, deps);
    const theirs = await other.svc.listContactsPage(
      other.actor.teamId,
      other.book.id,
      { limit: 25 },
    );
    if (!theirs.ok) throw new Error("unreachable");
    expect(theirs.data.data[0]!.subscribed).toBe(true);
  });
});

describe("CSV import", () => {
  const csv = [
    "email,first_name,last_name,plan",
    "ada@b.io,Ada,Lovelace,pro",
    '"grace@b.io",Grace,Hopper,free',
    "not-an-email,X,Y,z",
    "ada@b.io,Ada,Second,scale",
  ].join("\n");

  it("imports, reports the bad row, and lets the last duplicate win", async () => {
    const { actor, book: b, svc } = await book();
    const r = await svc.importContacts(actor, b.id, { csv }, deps);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data).toMatchObject({
      imported: 2,
      updated: 0,
      skipped: 1,
      duplicates: 1,
    });
    expect(r.data.errors).toEqual([
      { line: 4, email: "not-an-email", reason: "Enter a valid email." },
    ]);
    const page = await svc.listContactsPage(actor.teamId, b.id, { limit: 25 });
    if (!page.ok) throw new Error("unreachable");
    const ada = page.data.data.find((c) => c.email === "ada@b.io");
    expect(ada).toMatchObject({
      firstName: "Ada",
      lastName: "Second",
      properties: { plan: "scale" },
    });
  });

  it("updates existing contacts by default and leaves them alone when told not to", async () => {
    const { actor, book: b, svc } = await book();
    await svc.createContact(
      actor,
      b.id,
      { email: "ada@b.io", firstName: "Old" },
      deps,
    );
    const kept = await svc.importContacts(
      actor,
      b.id,
      { csv: "email,first_name\nada@b.io,New", updateExisting: false },
      deps,
    );
    if (!kept.ok) throw new Error("unreachable");
    expect(kept.data).toMatchObject({ imported: 0, updated: 0, skipped: 1 });
    const updated = await svc.importContacts(
      actor,
      b.id,
      { csv: "email,first_name\nada@b.io,New" },
      deps,
    );
    if (!updated.ok) throw new Error("unreachable");
    expect(updated.data).toMatchObject({ imported: 0, updated: 1 });
  });

  it("refuses a CSV with no email column, and one that is malformed", async () => {
    const { actor, book: b, svc } = await book();
    expect(
      await svc.importContacts(actor, b.id, { csv: "name\nAda" }, deps),
    ).toMatchObject({ ok: false, code: "validation_error" });
    expect(
      await svc.importContacts(
        actor,
        b.id,
        { csv: 'email\n"never closed' },
        deps,
      ),
    ).toMatchObject({ ok: false, code: "validation_error" });
  });

  it("writes one audit row for the whole import, not one per contact", async () => {
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { actor, book: b, svc } = await book();
    await svc.importContacts(actor, b.id, { csv }, deps);
    const rows = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.teamId, actor.teamId),
          eq(auditLog.action, "contacts.import"),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/contacts.test.ts`
Expected: FAIL — `@/services/contacts` does not exist.

- [ ] **Step 3: Write `apps/web/src/services/contacts.ts`**

```ts
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import {
  CreateContactBookInput,
  CreateContactInput,
  ImportContactsInput,
  UnsubscribeContactInput,
  UpdateContactBookInput,
  UpdateContactInput,
  can,
  newId,
  type ImportContactsResult,
  type ListContactsQuery,
  type PageQuery,
  type UnsubscribeResult,
  type WebhookEventType,
} from "@sendsprite/shared";
import { db } from "@/db";
import { keysetPage, type Page } from "@/db/keyset";
import {
  contactBooks,
  contacts,
  type Contact,
  type ContactBook,
} from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { parseCsv } from "@/lib/csv";
import { normaliseEmail } from "@/lib/email-address";
import type { Result } from "@/lib/result";
import type { Enqueue } from "./domains";
import { fanOutEvent } from "./webhooks";
import type { TeamActor } from "./team";

export type { Contact, ContactBook };
export interface ContactDeps {
  enqueue: Enqueue;
  now?: Date;
}

const DENIED: Result<never> = {
  ok: false,
  code: "forbidden",
  error: "You don't have permission to do that.",
};
const NO_BOOK: Result<never> = {
  ok: false,
  code: "not_found",
  error: "Contact book not found.",
};
const NO_CONTACT: Result<never> = {
  ok: false,
  code: "not_found",
  error: "Contact not found.",
};
const BOOK_UNIQUE = { target: [contacts.bookId, contacts.email] };

/** Rows applied per statement during an import. */
const IMPORT_CHUNK = 500;
/** Errors reported back; matches `ImportContactsResult.errors`' cap. */
const MAX_IMPORT_ERRORS = 100;

export interface ContactBookWithCounts extends ContactBook {
  contactCount: number;
  subscribedCount: number;
}

export const publicContactBook = (b: ContactBookWithCounts) => ({
  id: b.id,
  name: b.name,
  defaultFrom: b.defaultFrom,
  contactCount: b.contactCount,
  subscribedCount: b.subscribedCount,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

export const publicContact = (c: Contact) => ({
  id: c.id,
  bookId: c.bookId,
  email: c.email,
  firstName: c.firstName,
  lastName: c.lastName,
  properties: c.properties,
  subscribed: c.subscribed,
  unsubscribeReason: c.unsubscribeReason,
  unsubscribedAt: c.unsubscribedAt,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

/** One grouped count query, then a lookup — never a count per book. */
async function countsFor(
  bookIds: string[],
): Promise<Map<string, { contactCount: number; subscribedCount: number }>> {
  const out = new Map<
    string,
    { contactCount: number; subscribedCount: number }
  >();
  if (!bookIds.length) return out;
  const rows = await db()
    .select({
      bookId: contacts.bookId,
      contactCount: sql<number>`count(*)::int`,
      subscribedCount: sql<number>`count(*) filter (where ${contacts.subscribed})::int`,
    })
    .from(contacts)
    .where(inArray(contacts.bookId, bookIds))
    .groupBy(contacts.bookId);
  for (const r of rows)
    out.set(r.bookId, {
      contactCount: r.contactCount,
      subscribedCount: r.subscribedCount,
    });
  return out;
}

const withCounts = (
  books: ContactBook[],
  counts: Map<string, { contactCount: number; subscribedCount: number }>,
): ContactBookWithCounts[] =>
  books.map((b) => ({
    ...b,
    contactCount: counts.get(b.id)?.contactCount ?? 0,
    subscribedCount: counts.get(b.id)?.subscribedCount ?? 0,
  }));

/** Newest first, with counts (the dashboard list). */
export async function listBooks(
  teamId: string,
): Promise<ContactBookWithCounts[]> {
  const books = await db()
    .select()
    .from(contactBooks)
    .where(eq(contactBooks.teamId, teamId))
    .orderBy(desc(contactBooks.createdAt));
  return withCounts(books, await countsFor(books.map((b) => b.id)));
}

/** REST page, newest first; keyset paging on `(created_at, id)`. */
export async function listBooksPage(
  teamId: string,
  q: PageQuery,
): Promise<Result<Page<ContactBookWithCounts>>> {
  const page = await keysetPage(
    contactBooks,
    q,
    eq(contactBooks.teamId, teamId),
  );
  if (!page.ok) return page;
  const counts = await countsFor(page.data.data.map((b) => b.id));
  return {
    ok: true,
    data: { ...page.data, data: withCounts(page.data.data, counts) },
  };
}

export async function getBook(
  teamId: string,
  bookId: string,
): Promise<ContactBookWithCounts | null> {
  const [row] = await db()
    .select()
    .from(contactBooks)
    .where(and(eq(contactBooks.teamId, teamId), eq(contactBooks.id, bookId)));
  if (!row) return null;
  return withCounts(
    [row],
    await countsFor([row.id]),
  )[0] as ContactBookWithCounts;
}

export async function createBook(
  actor: TeamActor,
  raw: unknown,
): Promise<Result<ContactBookWithCounts>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = CreateContactBookInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const id = newId("cb");
  const [row] = await db()
    .insert(contactBooks)
    .values({
      id,
      teamId: actor.teamId,
      name: p.data.name,
      defaultFrom: p.data.defaultFrom ?? null,
    })
    .returning();
  if (!row) throw new Error("contact_books insert returned no row");
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contactBooks.create",
    targetType: "contactBook",
    targetId: id,
    diff: { name: { to: p.data.name } },
  });
  return { ok: true, data: { ...row, contactCount: 0, subscribedCount: 0 } };
}

export async function updateBook(
  actor: TeamActor,
  bookId: string,
  raw: unknown,
): Promise<Result<ContactBook>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = UpdateContactBookInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const [row] = await db()
    .update(contactBooks)
    .set({
      ...(p.data.name !== undefined && { name: p.data.name }),
      ...(p.data.defaultFrom !== undefined && {
        defaultFrom: p.data.defaultFrom,
      }),
      updatedAt: new Date(),
    })
    .where(
      and(eq(contactBooks.id, bookId), eq(contactBooks.teamId, actor.teamId)),
    )
    .returning();
  if (!row) return NO_BOOK;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contactBooks.update",
    targetType: "contactBook",
    targetId: bookId,
    diff: { name: { to: row.name } },
  });
  return { ok: true, data: row };
}

/**
 * Deleting a book cascades every contact in it away in one statement and
 * there is no history to restore from — so unlike the other contact
 * mutations it needs `settings.manage` (the same reasoning that makes
 * removing a suppression admin-only).
 */
export async function deleteBook(
  actor: TeamActor,
  bookId: string,
): Promise<Result> {
  if (!can(actor.role, "settings.manage")) return DENIED;
  const [row] = await db()
    .delete(contactBooks)
    .where(
      and(eq(contactBooks.id, bookId), eq(contactBooks.teamId, actor.teamId)),
    )
    .returning({ id: contactBooks.id, name: contactBooks.name });
  if (!row) return NO_BOOK;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contactBooks.delete",
    targetType: "contactBook",
    targetId: bookId,
    diff: { name: { from: row.name } },
  });
  return { ok: true, data: undefined };
}

/**
 * Best-effort `contact.*` fan-out. Never throws and never blocks the mutation
 * it describes — the same contract `recordAudit` has. The **import** path
 * deliberately does not call this per row: 10 000 deliveries into a customer's
 * endpoint from one button is an outage we caused.
 */
async function emitContact(
  teamId: string,
  type: Extract<WebhookEventType, `contact.${string}`>,
  contact: Contact,
  deps: ContactDeps,
): Promise<void> {
  try {
    await fanOutEvent(
      teamId,
      type,
      newId("evt"),
      publicContactAsJson(contact),
      {
        enqueue: deps.enqueue,
        createdAt: deps.now,
      },
    );
  } catch (e) {
    console.error("[contacts] webhook fan-out failed", (e as Error).message);
  }
}

/** Dates as ISO strings: a webhook payload is JSON, not a row. */
const publicContactAsJson = (c: Contact): Record<string, unknown> => {
  const v = publicContact(c);
  return {
    ...v,
    unsubscribedAt: v.unsubscribedAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
};

/** REST page of one book's contacts, newest first, with search and a subscription filter. */
export async function listContactsPage(
  teamId: string,
  bookId: string,
  q: ListContactsQuery,
): Promise<Result<Page<Contact>>> {
  const where: SQL[] = [
    eq(contacts.teamId, teamId),
    eq(contacts.bookId, bookId),
  ];
  if (q.subscribed !== undefined)
    where.push(eq(contacts.subscribed, q.subscribed));
  if (q.q) {
    const like = `${q.q.toLowerCase()}%`;
    const anywhere = `%${q.q.toLowerCase()}%`;
    const term = or(
      ilike(contacts.email, like),
      ilike(contacts.firstName, anywhere),
      ilike(contacts.lastName, anywhere),
    );
    if (term) where.push(term);
  }
  return keysetPage(contacts, q, and(...where));
}

export async function getContact(
  teamId: string,
  bookId: string,
  id: string,
): Promise<Contact | null> {
  const [row] = await db()
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.teamId, teamId),
        eq(contacts.bookId, bookId),
        eq(contacts.id, id),
      ),
    );
  return row ?? null;
}

export async function createContact(
  actor: TeamActor,
  bookId: string,
  raw: unknown,
  deps: ContactDeps,
): Promise<Result<Contact>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = CreateContactInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  if (!(await getBook(actor.teamId, bookId))) return NO_BOOK;
  const [row] = await db()
    .insert(contacts)
    .values({
      id: newId("ct"),
      bookId,
      teamId: actor.teamId,
      email: normaliseEmail(p.data.email),
      firstName: p.data.firstName ?? null,
      lastName: p.data.lastName ?? null,
      properties: p.data.properties,
      subscribed: p.data.subscribed,
      unsubscribedAt: p.data.subscribed ? null : (deps.now ?? new Date()),
    })
    .onConflictDoNothing(BOOK_UNIQUE)
    .returning();
  if (!row)
    return {
      ok: false,
      code: "conflict",
      error: "That address is already in this book.",
    };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contacts.create",
    targetType: "contact",
    targetId: row.id,
    diff: { email: { to: row.email }, bookId: { to: bookId } },
  });
  await emitContact(actor.teamId, "contact.created", row, deps);
  return { ok: true, data: row };
}

export async function updateContact(
  actor: TeamActor,
  bookId: string,
  id: string,
  raw: unknown,
  deps: ContactDeps,
): Promise<Result<Contact>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = UpdateContactInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const current = await getContact(actor.teamId, bookId, id);
  if (!current) return NO_CONTACT;
  const now = deps.now ?? new Date();
  const subscribed = p.data.subscribed ?? current.subscribed;
  const [row] = await db()
    .update(contacts)
    .set({
      ...(p.data.firstName !== undefined && { firstName: p.data.firstName }),
      ...(p.data.lastName !== undefined && { lastName: p.data.lastName }),
      ...(p.data.properties !== undefined && { properties: p.data.properties }),
      subscribed,
      // Coming back in clears the record of going out; going out stamps it.
      unsubscribedAt: subscribed ? null : (current.unsubscribedAt ?? now),
      unsubscribeReason: subscribed
        ? null
        : (p.data.unsubscribeReason ?? current.unsubscribeReason ?? "manual"),
      updatedAt: now,
    })
    .where(eq(contacts.id, id))
    .returning();
  if (!row) return NO_CONTACT;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contacts.update",
    targetType: "contact",
    targetId: id,
    diff: { subscribed: { from: current.subscribed, to: row.subscribed } },
  });
  if (current.subscribed !== row.subscribed)
    await emitContact(
      actor.teamId,
      row.subscribed ? "contact.resubscribed" : "contact.unsubscribed",
      row,
      deps,
    );
  else await emitContact(actor.teamId, "contact.updated", row, deps);
  return { ok: true, data: row };
}

export async function deleteContact(
  actor: TeamActor,
  bookId: string,
  id: string,
): Promise<Result> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const [row] = await db()
    .delete(contacts)
    .where(
      and(
        eq(contacts.teamId, actor.teamId),
        eq(contacts.bookId, bookId),
        eq(contacts.id, id),
      ),
    )
    .returning({ email: contacts.email });
  if (!row) return NO_CONTACT;
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contacts.delete",
    targetType: "contact",
    targetId: id,
    diff: { email: { from: row.email } },
  });
  return { ok: true, data: undefined };
}

/**
 * Unsubscribes an address across **every book of the team** unless `bookId`
 * narrows it: the person said stop, not "stop for book A".
 *
 * It writes **no suppression row**. Suppression blocks every send to an
 * address, transactional included — a customer who leaves a newsletter must
 * still get their password reset. See `packages/shared/src/api/contacts.ts`.
 */
export async function unsubscribeContact(
  actor: TeamActor,
  raw: unknown,
  deps: ContactDeps,
): Promise<Result<UnsubscribeResult>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = UnsubscribeContactInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  const now = deps.now ?? new Date();
  const rows = await db()
    .update(contacts)
    .set({
      subscribed: false,
      unsubscribedAt: now,
      unsubscribeReason: p.data.reason ?? "api",
      updatedAt: now,
    })
    .where(
      and(
        eq(contacts.teamId, actor.teamId),
        eq(contacts.email, normaliseEmail(p.data.email)),
        eq(contacts.subscribed, true),
        ...(p.data.bookId ? [eq(contacts.bookId, p.data.bookId)] : []),
      ),
    )
    .returning();
  if (rows.length) {
    await recordAudit({
      teamId: actor.teamId,
      actorUserId: actor.userId,
      ...actor.meta,
      action: "contacts.unsubscribe",
      targetType: "contact",
      targetId: normaliseEmail(p.data.email),
      diff: { unsubscribed: { to: rows.length } },
    });
    for (const row of rows)
      await emitContact(actor.teamId, "contact.unsubscribed", row, deps);
  }
  return { ok: true, data: { unsubscribed: rows.length } };
}

/** Header aliases accepted for the three known columns, case-insensitive. */
const EMAIL_HEADERS = new Set(["email", "email_address", "e-mail"]);
const FIRST_HEADERS = new Set(["first_name", "firstname", "first"]);
const LAST_HEADERS = new Set(["last_name", "lastname", "last"]);

/**
 * CSV → contacts, upserted into one book.
 *
 * Buffered rather than streamed: the input is capped at 2 MB by
 * `ImportContactsInput`, which is smaller than one permitted attachment, and
 * the JSON envelope is buffered by `req.json()` regardless.
 *
 * Duplicates **inside one file** are collapsed keeping the last occurrence,
 * and not only for tidiness: Postgres refuses `ON CONFLICT DO UPDATE` when a
 * single statement touches the same key twice, so an un-deduped chunk is a
 * hard error the first time a customer uploads a real export.
 *
 * A bad row is counted and reported; only a structurally broken document is
 * fatal, because after an unterminated quote nothing that follows can be read.
 */
export async function importContacts(
  actor: TeamActor,
  bookId: string,
  raw: unknown,
  deps: ContactDeps,
): Promise<Result<ImportContactsResult>> {
  if (!can(actor.role, "contacts.manage")) return DENIED;
  const p = ImportContactsInput.safeParse(raw);
  if (!p.success)
    return { ok: false, error: p.error.issues[0]?.message ?? "Invalid input." };
  if (!(await getBook(actor.teamId, bookId))) return NO_BOOK;
  const parsed = parseCsv(p.data.csv);
  if (!parsed.ok)
    return { ok: false, code: "validation_error", error: parsed.error };

  const header = parsed.data.header.map((h) => h.trim());
  const lower = header.map((h) => h.toLowerCase());
  const emailAt = lower.findIndex((h) => EMAIL_HEADERS.has(h));
  if (emailAt < 0)
    return {
      ok: false,
      code: "validation_error",
      error: 'The CSV needs an "email" column.',
      details: { header },
    };
  const firstAt = lower.findIndex((h) => FIRST_HEADERS.has(h));
  const lastAt = lower.findIndex((h) => LAST_HEADERS.has(h));
  const propertyAt = header
    .map((name, i) => ({ name, i }))
    .filter((c) => c.name && ![emailAt, firstAt, lastAt].includes(c.i));

  const errors: ImportContactsResult["errors"] = [];
  const byEmail = new Map<string, typeof contacts.$inferInsert>();
  let duplicates = 0;
  const now = deps.now ?? new Date();

  for (const row of parsed.data.rows) {
    const cell = (i: number) => (i < 0 ? "" : (row.cells[i] ?? "").trim());
    const rawEmail = cell(emailAt);
    const parsedContact = CreateContactInput.safeParse({
      email: rawEmail,
      firstName: cell(firstAt) || undefined,
      lastName: cell(lastAt) || undefined,
      properties: Object.fromEntries(
        propertyAt
          .map((c) => [c.name, cell(c.i)] as const)
          .filter(([, v]) => v !== ""),
      ),
    });
    if (!parsedContact.success) {
      if (errors.length < MAX_IMPORT_ERRORS)
        errors.push({
          line: row.line,
          email: rawEmail || null,
          reason: parsedContact.error.issues[0]?.message ?? "Invalid row.",
        });
      continue;
    }
    const email = normaliseEmail(parsedContact.data.email);
    if (byEmail.has(email)) duplicates++;
    byEmail.set(email, {
      id: newId("ct"),
      bookId,
      teamId: actor.teamId,
      email,
      firstName: parsedContact.data.firstName ?? null,
      lastName: parsedContact.data.lastName ?? null,
      properties: parsedContact.data.properties,
      subscribed: true,
      updatedAt: now,
    });
  }

  const candidates = [...byEmail.values()];
  // Which addresses are already in the book, so inserts and updates can be
  // reported separately (and so `updateExisting: false` can leave them alone).
  const existing = new Set<string>();
  for (let i = 0; i < candidates.length; i += IMPORT_CHUNK) {
    const chunk = candidates.slice(i, i + IMPORT_CHUNK).map((c) => c.email);
    const rows = await db()
      .select({ email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.bookId, bookId), inArray(contacts.email, chunk)));
    for (const r of rows) existing.add(r.email);
  }

  const toInsert = candidates.filter((c) => !existing.has(c.email as string));
  const toUpdate = p.data.updateExisting
    ? candidates.filter((c) => existing.has(c.email as string))
    : [];
  const skipped =
    errors.length +
    (p.data.updateExisting ? 0 : candidates.length - toInsert.length);

  for (const batch of [toInsert, toUpdate]) {
    for (let i = 0; i < batch.length; i += IMPORT_CHUNK) {
      const chunk = batch.slice(i, i + IMPORT_CHUNK);
      if (!chunk.length) continue;
      await db()
        .insert(contacts)
        .values(chunk)
        // `$onUpdate` does not fire on a conflict path, so `updatedAt` is set
        // explicitly here and in the values above.
        .onConflictDoUpdate({
          target: [contacts.bookId, contacts.email],
          set: {
            firstName: sql`excluded.first_name`,
            lastName: sql`excluded.last_name`,
            properties: sql`excluded.properties`,
            updatedAt: now,
          },
        });
    }
  }

  const data: ImportContactsResult = {
    imported: toInsert.length,
    updated: toUpdate.length,
    skipped,
    duplicates,
    errors,
  };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    ...actor.meta,
    action: "contacts.import",
    targetType: "contactBook",
    targetId: bookId,
    diff: {
      imported: { to: data.imported },
      updated: { to: data.updated },
      skipped: { to: data.skipped },
    },
  });
  // No per-contact webhook here on purpose: 10 000 deliveries into a
  // customer's endpoint from one button is an outage we caused. A summary
  // `contacts.imported` event is a Phase 7 opener.
  return { ok: true, data };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/contacts.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add apps/web/src/services/contacts.ts apps/web/tests/integration/contacts.test.ts
git commit -m "feat(contacts): books, contacts, CSV import and a team-wide unsubscribe"
```

---

## Task 8: `template` on `POST /emails` actually works

The refusal `createEmail` has carried since Phase 3 — `"template is not supported yet (Phase 5)"` — is replaced by a render. The ordering matters: the render happens **before** the idempotency lookup, so the fingerprint of a replay is computed over the same rendered bytes as the original, and a retry after the template changed is reported as an `idempotency_conflict` instead of silently returning an email whose body no longer matches.

**Files:**

- Modify: `packages/shared/src/api/emails.ts`, `apps/web/src/services/emails.ts`
- Test: `packages/shared/tests/api-emails.test.ts` (extend), `apps/web/tests/integration/emails.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/tests/api-emails.test.ts`:

```ts
describe("template and content-source rules", () => {
  const base = { from: "a@b.io", to: "c@d.io" };

  it("accepts a template with no subject — the template carries one", () => {
    const p = SendEmailInput.safeParse({
      ...base,
      template: "welcome",
      variables: { name: "Mingu" },
    });
    expect(p.success).toBe(true);
  });

  it("lets a request-level subject accompany a template", () => {
    expect(
      SendEmailInput.safeParse({
        ...base,
        template: "welcome",
        subject: "Override",
      }).success,
    ).toBe(true);
  });

  it("still requires a subject when there is no template", () => {
    expect(
      SendEmailInput.safeParse({ ...base, html: "<p>x</p>" }).success,
    ).toBe(false);
    expect(
      SendEmailInput.safeParse({ ...base, html: "<p>x</p>", subject: "s" })
        .success,
    ).toBe(true);
  });

  it("refuses a template together with html or text", () => {
    for (const extra of [{ html: "<p>x</p>" }, { text: "x" }])
      expect(
        SendEmailInput.safeParse({ ...base, template: "welcome", ...extra })
          .success,
      ).toBe(false);
  });

  it("refuses variables without a template", () => {
    expect(
      SendEmailInput.safeParse({
        ...base,
        subject: "s",
        text: "x",
        variables: { a: 1 },
      }).success,
    ).toBe(false);
  });
});
```

Append to `apps/web/tests/integration/emails.test.ts` (it already has a verified domain and an `enqueue` stub; reuse whatever that file names them — the block below assumes a `seedVerifiedDomain()`-shaped helper and a `deps` object with `enqueue`, matching the existing tests in the file):

```ts
describe("sending with a template", () => {
  it("renders server-side and stores the result, the template id and the variables", async () => {
    const { createEmail } = await import("@/services/emails");
    const { createTemplate } = await import("@/services/templates");
    const { actor, team, from } = await seedVerifiedDomain();
    const t = await createTemplate(actor, {
      slug: "welcome",
      name: "Welcome",
      subject: "Hi {{name}}",
      bodyHtml: "<p>Hello {{name}}</p>",
      bodyText: "Hello {{name}}",
    });
    if (!t.ok) throw new Error("seed failed");
    const res = await createEmail(
      { teamId: team.id, source: "api", apiKeyId: null, actorUserId: null },
      {
        from,
        to: "c@d.io",
        template: "welcome",
        variables: { name: "<Mingu>" },
      },
      deps,
    );
    if (!res.ok) throw new Error(`send failed: ${res.error}`);
    expect(res.data.subject).toBe("Hi <Mingu>");
    // Escaped in html, raw in text — the field decides, not the caller.
    expect(res.data.html).toContain("Hello &lt;Mingu&gt;");
    expect(res.data.text).toBe("Hello <Mingu>");
    expect(res.data.templateId).toBe(t.data.id);
    expect(res.data.variables).toEqual({ name: "<Mingu>" });
  });

  it("lets a request-level subject win over the template's", async () => {
    const { createEmail } = await import("@/services/emails");
    const { createTemplate } = await import("@/services/templates");
    const { actor, team, from } = await seedVerifiedDomain();
    await createTemplate(actor, {
      slug: "welcome",
      name: "W",
      subject: "From the template",
      bodyHtml: "<p>x</p>",
    });
    const res = await createEmail(
      { teamId: team.id, source: "api", apiKeyId: null, actorUserId: null },
      { from, to: "c@d.io", template: "welcome", subject: "From the request" },
      deps,
    );
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.subject).toBe("From the request");
  });

  it("refuses an unknown template and a template whose variables are missing", async () => {
    const { createEmail } = await import("@/services/emails");
    const { createTemplate } = await import("@/services/templates");
    const { actor, team, from } = await seedVerifiedDomain();
    await createTemplate(actor, {
      slug: "welcome",
      name: "W",
      subject: "Hi {{name}}",
      bodyHtml: "<p>{{name}}</p>",
    });
    const missingTemplate = await createEmail(
      { teamId: team.id, source: "api", apiKeyId: null, actorUserId: null },
      { from, to: "c@d.io", template: "nope" },
      deps,
    );
    expect(missingTemplate).toMatchObject({
      ok: false,
      code: "validation_error",
      details: { field: "template" },
    });
    const missingVariable = await createEmail(
      { teamId: team.id, source: "api", apiKeyId: null, actorUserId: null },
      { from, to: "c@d.io", template: "welcome" },
      deps,
    );
    expect(missingVariable).toMatchObject({
      ok: false,
      code: "validation_error",
    });
    expect(
      (missingVariable as { details: { missing: string[] } }).details.missing,
    ).toEqual(["name"]);
  });

  it("refuses a rendered subject carrying a line break", async () => {
    const { createEmail } = await import("@/services/emails");
    const { createTemplate } = await import("@/services/templates");
    const { actor, team, from } = await seedVerifiedDomain();
    await createTemplate(actor, {
      slug: "inject",
      name: "I",
      subject: "Hi {{name}}",
      bodyHtml: "<p>x</p>",
    });
    const res = await createEmail(
      { teamId: team.id, source: "api", apiKeyId: null, actorUserId: null },
      {
        from,
        to: "c@d.io",
        template: "inject",
        variables: { name: "x\r\nBcc: evil@x.io" },
      },
      deps,
    );
    expect(res).toMatchObject({ ok: false, code: "validation_error" });
  });

  it("replays an idempotent template send, and conflicts once the template changed", async () => {
    const { createEmail } = await import("@/services/emails");
    const { createTemplate, updateTemplate } =
      await import("@/services/templates");
    const { actor, team, from } = await seedVerifiedDomain();
    await createTemplate(actor, {
      slug: "welcome",
      name: "W",
      subject: "Hi",
      bodyHtml: "<p>v1</p>",
    });
    const ctx = {
      teamId: team.id,
      source: "api" as const,
      apiKeyId: null,
      actorUserId: null,
    };
    const body = {
      from,
      to: "c@d.io",
      template: "welcome",
      idempotencyKey: "k1",
    };
    const first = await createEmail(ctx, body, deps);
    if (!first.ok) throw new Error("unreachable");
    const replay = await createEmail(ctx, body, deps);
    if (!replay.ok) throw new Error("unreachable");
    expect(replay.created).toBe(false);
    expect(replay.data.id).toBe(first.data.id);
    await updateTemplate(actor, "welcome", { bodyHtml: "<p>v2</p>" });
    expect(await createEmail(ctx, body, deps)).toMatchObject({
      ok: false,
      code: "idempotency_conflict",
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd packages/shared && bunx vitest run tests/api-emails.test.ts`
Expected: FAIL — a template with no subject is rejected, and `template` + `html` is accepted.

Run: `cd apps/web && bunx vitest run --project integration tests/integration/emails.test.ts`
Expected: FAIL — `template is not supported yet (Phase 5)`.

- [ ] **Step 3: Loosen and tighten `SendEmailInput`**

In `packages/shared/src/api/emails.ts`, change the `subject` field inside `SendEmailInput` from

```ts
    subject: noCrlf(z.string().min(1).max(998)),
```

to

```ts
    /**
     * Optional only because a template carries its own; the refines below
     * require one of the two. A request-level subject wins over the
     * template's, so a single template can serve several subject lines.
     */
    subject: noCrlf(z.string().min(1).max(998)).optional(),
```

and replace the two trailing `.refine(...)` calls on `SendEmailInput` with these five:

```ts
  .refine((v) => v.html || v.text || v.template, {
    message: "one of html, text or template is required",
  })
  // "Exactly one content source" (spec §7). Accepting both and preferring one
  // would make the other silently invisible.
  .refine((v) => !(v.template && (v.html || v.text)), {
    message: "template cannot be combined with html or text",
  })
  .refine((v) => !(v.variables && !v.template), {
    message: "variables requires template",
  })
  .refine((v) => Boolean(v.subject || v.template), {
    message: "subject is required unless a template supplies one",
  })
  .refine((v) => v.to.length + v.cc.length + v.bcc.length <= MAX_RECIPIENTS, {
    message: `at most ${MAX_RECIPIENTS} recipients`,
  });
```

- [ ] **Step 4: Render on the send path**

In `apps/web/src/services/emails.ts`:

1. Add to the imports:

```ts
import { getTemplate } from "./templates";
import { renderTemplate } from "@sendsprite/shared";
```

(`renderTemplate` joins the existing `@sendsprite/shared` import list rather than a second import statement.)

2. Delete these two lines:

```ts
if (input.template)
  return fail("validation_error", "template is not supported yet (Phase 5).");
```

3. Immediately after the `if (!isList(to) || …) return fail(…)` block and **before** the `if (input.idempotencyKey)` block, insert:

```ts
// Rendered here — before the idempotency lookup — so a replay's fingerprint
// is computed over the same bytes the first send stored. Rendering after the
// lookup would compare a rendered body against a template-rendered row only
// by luck, and a retry issued after the template changed would silently
// return an email whose body no longer matches the request.
let templateId: string | null = null;
let variables: Record<string, unknown> | null = null;
let subject = input.subject?.trim() ?? "";
let html = input.html ?? null;
let text = input.text ?? null;
if (input.template) {
  const tpl = await getTemplate(ctx.teamId, input.template);
  if (!tpl)
    return fail("validation_error", `Template "${input.template}" not found.`, {
      field: "template",
    });
  const rendered = renderTemplate(
    { subject: tpl.subject, bodyHtml: tpl.bodyHtml, bodyText: tpl.bodyText },
    input.variables ?? {},
    tpl.variablesSchema,
  );
  if (!rendered.ok)
    return fail("validation_error", rendered.error, {
      field: "variables",
      missing: rendered.missing,
      invalid: rendered.invalid,
    });
  templateId = tpl.id;
  variables = input.variables ?? {};
  // A request-level subject wins; otherwise the template's rendered one.
  subject = subject || rendered.data.subject;
  html = rendered.data.html;
  text = rendered.data.text;
}
// The schema's refine guarantees this for both paths; kept because a
// subject is what reaches the MIME header and a silent empty one is worse
// than a 400.
if (!subject) return fail("validation_error", "subject is required.");
```

4. In the idempotency replay comparison, replace the two uses of `input.subject` / `input.html` / `input.text` so it reads:

```ts
const same = existing.bodyPurgedAt
  ? existing.subject === subject &&
    JSON.stringify([...existing.to].sort()) === JSON.stringify([...to].sort())
  : fingerprint(existing) ===
    fingerprint({
      subject,
      to,
      html: applyTracking(html, existing.id, existing),
      text,
    });
```

5. In the insert `.values({ … })`, replace `subject: input.subject`, `html`, `text: input.text ?? null` with the resolved values and add the two new columns. The `html` binding above the insert also changes:

```ts
const id = newId("em");
const trackedHtml = applyTracking(html, id, tracking);
```

and inside `.values({ … })`:

```ts
          subject,
          html: trackedHtml,
          text,
          templateId,
          variables,
```

(the previous `const html = applyTracking(input.html ?? null, id, tracking);` line is replaced by `trackedHtml`, because `html` now holds the un-tracked rendered body.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/shared && bunx vitest run`
Run: `cd apps/web && bunx vitest run --project integration tests/integration/emails.test.ts`
Expected: PASS.

- [ ] **Step 6: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add packages/shared apps/web
git commit -m "feat(emails): render a stored template on the send path"
```

---

## Task 9: REST — templates, and the OpenAPI document

Three route files, and the OpenAPI entries that keep `openapi-coverage.test.ts` green. That test fails both ways — a route with no entry **and** an entry with no route — so the document and the routes land in one commit.

**Files:**

- Create: `apps/web/src/app/api/v1/templates/route.ts`, `apps/web/src/app/api/v1/templates/[slug]/route.ts`, `apps/web/src/app/api/v1/templates/[slug]/render/route.ts`
- Modify: `packages/shared/src/api/templates.ts` (add `TemplateDetail`), `packages/shared/src/openapi.ts`
- Test: `apps/web/tests/integration/rest-templates.test.ts`, `packages/shared/tests/openapi.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

`apps/web/tests/integration/rest-templates.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
let secret: string;
let sendingOnly: string;
beforeAll(async () => {
  pg = await startPg();
  secret = (await seedTeamWithKey()).secret;
  sendingOnly = (await seedTeamWithKey({ permission: "sending_only" })).secret;
});
afterAll(async () => {
  await pg.stop();
});

const BASE = "http://localhost/api/v1/templates";
const req = (method: string, url = BASE, key?: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const noParams = { params: Promise.resolve({}) };
const withSlug = (slug: string) => ({ params: Promise.resolve({ slug }) });

const draft = {
  slug: "welcome",
  name: "Welcome",
  subject: "Hi {{name}}",
  bodyHtml: "<p>Hello {{name}}</p>",
};

describe("REST /api/v1/templates", () => {
  it("401 without a key, 403 for a sending-only key on every route", async () => {
    const list = await import("@/app/api/v1/templates/route");
    const one = await import("@/app/api/v1/templates/[slug]/route");
    const render = await import("@/app/api/v1/templates/[slug]/render/route");
    expect((await list.GET(req("GET"), noParams)).status).toBe(401);
    for (const res of [
      await list.GET(req("GET", BASE, sendingOnly), noParams),
      await list.POST(req("POST", BASE, sendingOnly, draft), noParams),
      await one.GET(req("GET", BASE, sendingOnly), withSlug("welcome")),
      await one.PATCH(
        req("PATCH", BASE, sendingOnly, { name: "x" }),
        withSlug("welcome"),
      ),
      await one.DELETE(req("DELETE", BASE, sendingOnly), withSlug("welcome")),
      await render.POST(
        req("POST", BASE, sendingOnly, {}),
        withSlug("welcome"),
      ),
    ])
      expect(res.status).toBe(403);
  });

  it("creates (201), lists, reads with its version history, patches and deletes (204)", async () => {
    const list = await import("@/app/api/v1/templates/route");
    const one = await import("@/app/api/v1/templates/[slug]/route");
    const created = await list.POST(req("POST", BASE, secret, draft), noParams);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ slug: "welcome", version: 1 });

    const page = await list.GET(req("GET", BASE, secret), noParams);
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ nextCursor: null });

    await one.PATCH(
      req("PATCH", BASE, secret, { bodyHtml: "<p>v2 {{name}}</p>" }),
      withSlug("welcome"),
    );
    const read = await one.GET(req("GET", BASE, secret), withSlug("welcome"));
    const detail = (await read.json()) as {
      version: number;
      versions: { version: number }[];
    };
    expect(detail.version).toBe(2);
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);

    expect(
      (await one.DELETE(req("DELETE", BASE, secret), withSlug("welcome")))
        .status,
    ).toBe(204);
    expect(
      (await one.GET(req("GET", BASE, secret), withSlug("welcome"))).status,
    ).toBe(404);
  });

  it("409 on a duplicate slug and 400 on a bad body", async () => {
    const list = await import("@/app/api/v1/templates/route");
    await list.POST(
      req("POST", BASE, secret, { ...draft, slug: "dupe" }),
      noParams,
    );
    const again = await list.POST(
      req("POST", BASE, secret, { ...draft, slug: "dupe" }),
      noParams,
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "conflict" } });
    const bad = await list.POST(
      req("POST", BASE, secret, { ...draft, slug: "Not A Slug" }),
      noParams,
    );
    expect(bad.status).toBe(400);
  });

  it("renders with the caller's variables and 400s when one is missing", async () => {
    const list = await import("@/app/api/v1/templates/route");
    const render = await import("@/app/api/v1/templates/[slug]/render/route");
    await list.POST(
      req("POST", BASE, secret, { ...draft, slug: "render" }),
      noParams,
    );
    const ok = await render.POST(
      req("POST", BASE, secret, { variables: { name: "Ada & Co" } }),
      withSlug("render"),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      subject: "Hi Ada & Co",
      html: "<p>Hello Ada &amp; Co</p>",
      text: null,
    });
    const missing = await render.POST(
      req("POST", BASE, secret, { variables: {} }),
      withSlug("render"),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: { code: "validation_error", details: { missing: ["name"] } },
    });
    expect(
      (await render.POST(req("POST", BASE, secret, {}), withSlug("nope")))
        .status,
    ).toBe(404);
  });
});
```

Append to `packages/shared/tests/openapi.test.ts`:

```ts
it("documents every templates and contacts operation", () => {
  const expected: Record<string, string[]> = {
    "/templates": ["get", "post"],
    "/templates/{slug}": ["get", "patch", "delete"],
    "/templates/{slug}/render": ["post"],
    "/contact-books": ["get", "post"],
    "/contact-books/{id}": ["get", "patch", "delete"],
    "/contact-books/{id}/contacts": ["get", "post"],
    "/contact-books/{id}/contacts/{contactId}": ["get", "patch", "delete"],
    "/contact-books/{id}/contacts/import": ["post"],
    "/contacts/unsubscribe": ["post"],
  };
  for (const [path, methods] of Object.entries(expected)) {
    const item = (doc.paths as Record<string, Record<string, unknown>>)[path];
    expect(item, path).toBeDefined();
    expect(Object.keys(item!).sort()).toEqual([...methods].sort());
  }
  expect(doc.tags.map((t) => t.name)).toEqual(
    expect.arrayContaining(["Templates", "Contacts"]),
  );
  // The render endpoint is a dry run, so it has no side-effect statuses.
  expect(
    doc.paths["/templates/{slug}/render"].post.responses["200"]?.content?.[
      "application/json"
    ]?.schema,
  ).toEqual({ $ref: "#/components/schemas/RenderedTemplateObject" });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/rest-templates.test.ts`
Expected: FAIL — the route modules do not exist.

Run: `cd packages/shared && bunx vitest run tests/openapi.test.ts`
Expected: FAIL — `/templates` is undefined.

- [ ] **Step 3: Add `TemplateDetail` to the shared contracts**

Append to `packages/shared/src/api/templates.ts`:

```ts
/**
 * `GET /templates/:slug`: the template plus its recent versions, newest
 * first — the same shape `GET /emails/:id` uses for its event timeline.
 */
export const TemplateDetail = TemplateObject.extend({
  versions: z.array(TemplateVersionObject),
});
export type TemplateDetail = z.infer<typeof TemplateDetail>;
```

- [ ] **Step 4: Write the three route files**

`apps/web/src/app/api/v1/templates/route.ts`:

```ts
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  pagedList,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  createTemplate,
  listTemplatesPage,
  publicTemplate,
} from "@/services/templates";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  (req, auth) =>
    pagedList(req, (q) => listTemplatesPage(auth.team.id, q), publicTemplate),
  { permission: "full" },
);

export const POST = withApiKey(
  async (req, auth) => {
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createTemplate(keyActor(auth), json);
    if (!res.ok) return serviceFailure(res);
    return ok(publicTemplate(res.data), { status: 201 });
  },
  { permission: "full" },
);
```

`apps/web/src/app/api/v1/templates/[slug]/route.ts`:

```ts
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  noContent,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  deleteTemplate,
  getTemplate,
  listTemplateVersions,
  publicTemplate,
  publicTemplateVersion,
  updateTemplate,
} from "@/services/templates";

export const dynamic = "force-dynamic";

/** The segment is the slug, but an id works too (`services/templates.ts`). */
export const GET = withApiKey(
  async (_req, auth, ctx) => {
    const { slug } = await ctx.params;
    const t = await getTemplate(auth.team.id, slug ?? "");
    if (!t) return fail("not_found", "Template not found.");
    return ok({
      ...publicTemplate(t),
      versions: (await listTemplateVersions(auth.team.id, t.id)).map(
        publicTemplateVersion,
      ),
    });
  },
  { permission: "full" },
);

export const PATCH = withApiKey(
  async (req, auth, ctx) => {
    const { slug } = await ctx.params;
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await updateTemplate(keyActor(auth), slug ?? "", json);
    if (!res.ok) return serviceFailure(res);
    return ok(publicTemplate(res.data));
  },
  { permission: "full" },
);

export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { slug } = await ctx.params;
    const res = await deleteTemplate(keyActor(auth), slug ?? "");
    if (!res.ok) return serviceFailure(res);
    return noContent();
  },
  { permission: "full" },
);
```

`apps/web/src/app/api/v1/templates/[slug]/render/route.ts`:

```ts
import { RenderTemplateInput } from "@sendsprite/shared";
import {
  fail,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import { renderStoredTemplate } from "@/services/templates";

export const dynamic = "force-dynamic";

/**
 * A dry run: nothing is sent, nothing is stored, and the escaping is exactly
 * what a send would produce — the send path and this endpoint share
 * `renderStoredTemplate`. A `full` key only: it returns template content.
 */
export const POST = withApiKey(
  async (req, auth, ctx) => {
    const { slug } = await ctx.params;
    const json = (await readJson(req)) ?? {};
    const p = RenderTemplateInput.safeParse(json);
    if (!p.success)
      return fail(
        "validation_error",
        p.error.issues[0]?.message ?? "Invalid body.",
        p.error.issues,
      );
    const res = await renderStoredTemplate(
      auth.team.id,
      slug ?? "",
      p.data.variables,
    );
    if (!res.ok) return serviceFailure(res);
    return ok(res.data);
  },
  { permission: "full" },
);
```

- [ ] **Step 5: Document the three paths**

In `packages/shared/src/openapi.ts`:

1. Add the imports:

```ts
import {
  CreateTemplateInput,
  RenderTemplateInput,
  RenderedTemplateObject,
  TemplateDetail,
  TemplateObject,
  TemplateVersionObject,
  UpdateTemplateInput,
} from "./api/templates";
```

2. Add to `inputSchemas`: `CreateTemplateInput,`, `UpdateTemplateInput,`, `RenderTemplateInput,`.

3. Add to `outputSchemas`:

```ts
  TemplateObject,
  TemplateVersionObject,
  TemplateDetail,
  TemplatePage: pageOf(TemplateObject),
  RenderedTemplateObject,
```

4. Add `{ name: "Templates" },` to the `tags` array, after `{ name: "Suppressions" }`.

5. Add these three entries to `paths`, after `/suppressions/{email}`:

```ts
    "/templates": {
      get: op("Templates", "listTemplates", "List templates", {
        parameters: pageParams,
        responses: {
          "200": json(ref("TemplatePage"), "Page of templates"),
          ...errors(...common, "validation_error"),
        },
      }),
      post: op("Templates", "createTemplate", "Create a template", {
        description:
          "`slug` is the name `POST /emails` uses in `template`, and is unique per team. Bodies use `{{ variable }}` placeholders; values are HTML-escaped into `bodyHtml` and left raw in `bodyText`.",
        requestBody: body("CreateTemplateInput"),
        responses: {
          "201": json(ref("TemplateObject"), "Template"),
          ...errors(...common, "validation_error", "conflict"),
        },
      }),
    },
    "/templates/{slug}": {
      get: op("Templates", "getTemplate", "Get a template and its versions", {
        description: "The path segment accepts the slug or the `tpl_…` id.",
        parameters: [idParam("slug", "Template slug, or its id.")],
        responses: {
          "200": json(ref("TemplateDetail"), "Template with its version history"),
          ...errors(...common, "not_found"),
        },
      }),
      patch: op("Templates", "updateTemplate", "Update a template", {
        description:
          "A content change bumps `version` and appends a snapshot; an update that changes nothing does neither. `slug` cannot be changed — a live send names a template by slug, so a rename is a create plus a delete.",
        parameters: [idParam("slug", "Template slug, or its id.")],
        requestBody: body("UpdateTemplateInput"),
        responses: {
          "200": json(ref("TemplateObject"), "Updated template"),
          ...errors(...common, "validation_error", "not_found"),
        },
      }),
      delete: op("Templates", "deleteTemplate", "Delete a template", {
        description:
          "Emails already sent from it keep their stored bodies; their `templateId` becomes null.",
        parameters: [idParam("slug", "Template slug, or its id.")],
        responses: {
          "204": { description: "Deleted" },
          ...errors(...common, "not_found"),
        },
      }),
    },
    "/templates/{slug}/render": {
      post: op("Templates", "renderTemplate", "Render a template", {
        description:
          "A dry run: nothing is sent or stored, and the output is byte-identical to what `POST /emails` would store for the same variables. A missing or non-scalar variable is a `400` naming it.",
        parameters: [idParam("slug", "Template slug, or its id.")],
        requestBody: body("RenderTemplateInput"),
        responses: {
          "200": json(ref("RenderedTemplateObject"), "Rendered subject and bodies"),
          ...errors(...common, "validation_error", "not_found"),
        },
      }),
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/shared && bunx vitest run`
Run: `cd apps/web && bunx vitest run --project unit tests/unit/openapi-coverage.test.ts`
Run: `cd apps/web && bunx vitest run --project integration tests/integration/rest-templates.test.ts`
Expected: PASS.

- [ ] **Step 7: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add packages/shared apps/web
git commit -m "feat(api): templates REST endpoints and their OpenAPI entries"
```

---

## Task 10: REST — contact books, contacts, import and unsubscribe

Six route files. `contact-books/[id]/contacts/import` sits beside `contact-books/[id]/contacts/[contactId]`: Next matches the static segment first, and contact ids are `ct_<ulid>`, so nothing is shadowed.

**Files:**

- Create: `apps/web/src/app/api/v1/contact-books/route.ts`, `.../[id]/route.ts`, `.../[id]/contacts/route.ts`, `.../[id]/contacts/[contactId]/route.ts`, `.../[id]/contacts/import/route.ts`, `apps/web/src/app/api/v1/contacts/unsubscribe/route.ts`
- Modify: `packages/shared/src/openapi.ts`
- Test: `apps/web/tests/integration/rest-contacts.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/web/tests/integration/rest-contacts.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
let secret: string;
let sendingOnly: string;
beforeAll(async () => {
  pg = await startPg();
  secret = (await seedTeamWithKey()).secret;
  sendingOnly = (await seedTeamWithKey({ permission: "sending_only" })).secret;
});
afterAll(async () => {
  await pg.stop();
});

const BOOKS = "http://localhost/api/v1/contact-books";
const req = (method: string, url: string, key?: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = (p: Record<string, string> = {}) => ({
  params: Promise.resolve(p),
});

async function newBook(): Promise<string> {
  const list = await import("@/app/api/v1/contact-books/route");
  const res = await list.POST(
    req("POST", BOOKS, secret, { name: `Book ${Math.random()}` }),
    params(),
  );
  return ((await res.json()) as { id: string }).id;
}

describe("REST /api/v1/contact-books", () => {
  it("401 without a key and 403 for a sending-only key", async () => {
    const list = await import("@/app/api/v1/contact-books/route");
    expect((await list.GET(req("GET", BOOKS), params())).status).toBe(401);
    expect(
      (await list.GET(req("GET", BOOKS, sendingOnly), params())).status,
    ).toBe(403);
  });

  it("creates a book (201) with counts, lists it, patches and deletes it", async () => {
    const list = await import("@/app/api/v1/contact-books/route");
    const one = await import("@/app/api/v1/contact-books/[id]/route");
    const created = await list.POST(
      req("POST", BOOKS, secret, { name: "News" }),
      params(),
    );
    expect(created.status).toBe(201);
    const book = (await created.json()) as { id: string };
    expect(book).toMatchObject({
      name: "News",
      contactCount: 0,
      subscribedCount: 0,
    });
    const page = await list.GET(req("GET", BOOKS, secret), params());
    expect(page.status).toBe(200);
    const patched = await one.PATCH(
      req("PATCH", BOOKS, secret, { name: "Newsletter" }),
      params({ id: book.id }),
    );
    expect(await patched.json()).toMatchObject({ name: "Newsletter" });
    expect(
      (await one.DELETE(req("DELETE", BOOKS, secret), params({ id: book.id })))
        .status,
    ).toBe(204);
    expect(
      (await one.GET(req("GET", BOOKS, secret), params({ id: book.id })))
        .status,
    ).toBe(404);
  });

  it("creates, lists, searches, patches and deletes contacts under a book", async () => {
    const many = await import("@/app/api/v1/contact-books/[id]/contacts/route");
    const one =
      await import("@/app/api/v1/contact-books/[id]/contacts/[contactId]/route");
    const id = await newBook();
    const url = `${BOOKS}/${id}/contacts`;
    const created = await many.POST(
      req("POST", url, secret, { email: "Ada@B.io", firstName: "Ada" }),
      params({ id }),
    );
    expect(created.status).toBe(201);
    const contact = (await created.json()) as { id: string; email: string };
    expect(contact.email).toBe("ada@b.io");

    const dupe = await many.POST(
      req("POST", url, secret, { email: "ada@b.io" }),
      params({ id }),
    );
    expect(dupe.status).toBe(409);

    const found = await many.GET(
      req("GET", `${url}?q=ada`, secret),
      params({ id }),
    );
    expect((await found.json()) as { data: unknown[] }).toMatchObject({
      data: [{ email: "ada@b.io" }],
    });
    const none = await many.GET(
      req("GET", `${url}?subscribed=false`, secret),
      params({ id }),
    );
    expect((await none.json()) as { data: unknown[] }).toMatchObject({
      data: [],
    });

    const patched = await one.PATCH(
      req("PATCH", url, secret, { subscribed: false }),
      params({ id, contactId: contact.id }),
    );
    expect(await patched.json()).toMatchObject({ subscribed: false });
    expect(
      (
        await one.DELETE(
          req("DELETE", url, secret),
          params({ id, contactId: contact.id }),
        )
      ).status,
    ).toBe(204);
  });

  it("imports a CSV and reports counts and per-row errors", async () => {
    const imp =
      await import("@/app/api/v1/contact-books/[id]/contacts/import/route");
    const id = await newBook();
    const res = await imp.POST(
      req("POST", `${BOOKS}/${id}/contacts/import`, secret, {
        csv: "email,first_name\nada@b.io,Ada\nbroken,X\n",
      }),
      params({ id }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      imported: 1,
      updated: 0,
      skipped: 1,
      duplicates: 0,
      errors: [{ line: 3, email: "broken" }],
    });
  });

  it("refuses an import body larger than the route's own cap", async () => {
    const imp =
      await import("@/app/api/v1/contact-books/[id]/contacts/import/route");
    const id = await newBook();
    const request = new Request(`${BOOKS}/${id}/contacts/import`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "content-length": String(64 * 1024 * 1024),
      },
      body: JSON.stringify({ csv: "email\na@b.io" }),
    });
    const res = await imp.POST(request, params({ id }));
    expect(res.status).toBe(413);
  });

  it("unsubscribes by address across the team and never writes a suppression", async () => {
    const { db } = await import("@/db");
    const { suppressions } = await import("@/db/schema");
    const many = await import("@/app/api/v1/contact-books/[id]/contacts/route");
    const uns = await import("@/app/api/v1/contacts/unsubscribe/route");
    const a = await newBook();
    const b = await newBook();
    for (const id of [a, b])
      await many.POST(
        req("POST", `${BOOKS}/${id}/contacts`, secret, { email: "x@y.io" }),
        params({ id }),
      );
    const res = await uns.POST(
      req("POST", "http://localhost/api/v1/contacts/unsubscribe", secret, {
        email: "X@Y.io",
        reason: "link",
      }),
      params(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unsubscribed: 2 });
    expect(await db().select().from(suppressions)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/rest-contacts.test.ts`
Expected: FAIL — the route modules do not exist.

- [ ] **Step 3: Write the six route files**

`apps/web/src/app/api/v1/contact-books/route.ts`:

```ts
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  pagedList,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  createBook,
  listBooksPage,
  publicContactBook,
} from "@/services/contacts";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  (req, auth) =>
    pagedList(req, (q) => listBooksPage(auth.team.id, q), publicContactBook),
  { permission: "full" },
);

export const POST = withApiKey(
  async (req, auth) => {
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createBook(keyActor(auth), json);
    if (!res.ok) return serviceFailure(res);
    return ok(publicContactBook(res.data), { status: 201 });
  },
  { permission: "full" },
);
```

`apps/web/src/app/api/v1/contact-books/[id]/route.ts`:

```ts
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  noContent,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  deleteBook,
  getBook,
  publicContactBook,
  updateBook,
} from "@/services/contacts";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const b = await getBook(auth.team.id, id ?? "");
    if (!b) return fail("not_found", "Contact book not found.");
    return ok(publicContactBook(b));
  },
  { permission: "full" },
);

export const PATCH = withApiKey(
  async (req, auth, ctx) => {
    const { id } = await ctx.params;
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await updateBook(keyActor(auth), id ?? "", json);
    if (!res.ok) return serviceFailure(res);
    const b = await getBook(auth.team.id, res.data.id);
    if (!b) return fail("not_found", "Contact book not found.");
    return ok(publicContactBook(b));
  },
  { permission: "full" },
);

/** Cascades every contact in the book away; needs `settings.manage`. */
export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { id } = await ctx.params;
    const res = await deleteBook(keyActor(auth), id ?? "");
    if (!res.ok) return serviceFailure(res);
    return noContent();
  },
  { permission: "full" },
);
```

`apps/web/src/app/api/v1/contact-books/[id]/contacts/route.ts`:

```ts
import { ListContactsQuery } from "@sendsprite/shared";
import { enqueue } from "@/jobs/enqueue";
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  createContact,
  listContactsPage,
  publicContact,
} from "@/services/contacts";

export const dynamic = "force-dynamic";

/** `{ data, nextCursor }`; `?q=` matches an address prefix or either name. */
export const GET = withApiKey(
  async (req, auth, ctx) => {
    const { id } = await ctx.params;
    const q = ListContactsQuery.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!q.success)
      return fail(
        "validation_error",
        q.error.issues[0]?.message ?? "Invalid query.",
        q.error.issues,
      );
    const page = await listContactsPage(auth.team.id, id ?? "", q.data);
    if (!page.ok) return serviceFailure(page);
    return ok({
      data: page.data.data.map(publicContact),
      nextCursor: page.data.nextCursor,
    });
  },
  { permission: "full" },
);

export const POST = withApiKey(
  async (req, auth, ctx) => {
    const { id } = await ctx.params;
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await createContact(keyActor(auth), id ?? "", json, {
      enqueue,
    });
    if (!res.ok) return serviceFailure(res);
    return ok(publicContact(res.data), { status: 201 });
  },
  { permission: "full" },
);
```

`apps/web/src/app/api/v1/contact-books/[id]/contacts/[contactId]/route.ts`:

```ts
import { enqueue } from "@/jobs/enqueue";
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  noContent,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import {
  deleteContact,
  getContact,
  publicContact,
  updateContact,
} from "@/services/contacts";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  async (_req, auth, ctx) => {
    const { id, contactId } = await ctx.params;
    const c = await getContact(auth.team.id, id ?? "", contactId ?? "");
    if (!c) return fail("not_found", "Contact not found.");
    return ok(publicContact(c));
  },
  { permission: "full" },
);

/** `{ subscribed: false }` here is the same consent change as the unsubscribe endpoint. */
export const PATCH = withApiKey(
  async (req, auth, ctx) => {
    const { id, contactId } = await ctx.params;
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await updateContact(
      keyActor(auth),
      id ?? "",
      contactId ?? "",
      json,
      { enqueue },
    );
    if (!res.ok) return serviceFailure(res);
    return ok(publicContact(res.data));
  },
  { permission: "full" },
);

export const DELETE = withApiKey(
  async (_req, auth, ctx) => {
    const { id, contactId } = await ctx.params;
    const res = await deleteContact(keyActor(auth), id ?? "", contactId ?? "");
    if (!res.ok) return serviceFailure(res);
    return noContent();
  },
  { permission: "full" },
);
```

`apps/web/src/app/api/v1/contact-books/[id]/contacts/import/route.ts`:

```ts
import { enqueue } from "@/jobs/enqueue";
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import { importContacts } from "@/services/contacts";

export const dynamic = "force-dynamic";

/**
 * A 2 MB CSV inside a JSON envelope needs a few MB, not the 25 MB the email
 * routes need for base64 attachments — so this route carries its own cap, the
 * way `api/billing/webhook` does. The `content-length` check refuses an
 * oversized body before it is buffered; a chunked request declares none, so
 * `ImportContactsInput`'s own 2 MB bound on `csv` is the backstop.
 *
 * The path segment `import` sits beside `[contactId]`; Next matches the static
 * segment first, and contact ids are `ct_<ulid>`, so nothing is shadowed.
 */
const MAX_IMPORT_BYTES = 4 * 1024 * 1024;

export const POST = withApiKey(
  async (req, auth, ctx) => {
    if (Number(req.headers.get("content-length")) > MAX_IMPORT_BYTES)
      return fail(
        "payload_too_large",
        `Request body must be at most ${MAX_IMPORT_BYTES} bytes.`,
      );
    const { id } = await ctx.params;
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await importContacts(keyActor(auth), id ?? "", json, {
      enqueue,
    });
    if (!res.ok) return serviceFailure(res);
    return ok(res.data);
  },
  { permission: "full" },
);
```

`apps/web/src/app/api/v1/contacts/unsubscribe/route.ts`:

```ts
import { enqueue } from "@/jobs/enqueue";
import { keyActor } from "@/lib/api-auth";
import {
  fail,
  ok,
  readJson,
  serviceFailure,
  withApiKey,
} from "@/lib/api-response";
import { unsubscribeContact } from "@/services/contacts";

export const dynamic = "force-dynamic";

/**
 * Consent, not deliverability: this records that a person does not want a
 * kind of mail, across every book of the team unless `bookId` narrows it. It
 * writes **no suppression row** — a customer who leaves a newsletter must
 * still receive their password reset. `POST /suppressions` is the endpoint
 * that stops all mail to an address.
 *
 * Idempotent: unsubscribing an address that is already out returns
 * `{ unsubscribed: 0 }` and a 200.
 */
export const POST = withApiKey(
  async (req, auth) => {
    const json = await readJson(req);
    if (json === undefined)
      return fail("validation_error", "Body must be JSON.");
    const res = await unsubscribeContact(keyActor(auth), json, { enqueue });
    if (!res.ok) return serviceFailure(res);
    return ok(res.data);
  },
  { permission: "full" },
);
```

- [ ] **Step 4: Document the six paths**

In `packages/shared/src/openapi.ts`:

1. Add the imports:

```ts
import {
  ContactBookObject,
  ContactObject,
  CreateContactBookInput,
  CreateContactInput,
  ImportContactsInput,
  ImportContactsResult,
  UnsubscribeContactInput,
  UnsubscribeResult,
  UpdateContactBookInput,
  UpdateContactInput,
} from "./api/contacts";
```

2. Add to `inputSchemas`: `CreateContactBookInput,`, `UpdateContactBookInput,`, `CreateContactInput,`, `UpdateContactInput,`, `ImportContactsInput,`, `UnsubscribeContactInput,`.

3. Add to `outputSchemas`:

```ts
  ContactBookObject,
  ContactBookPage: pageOf(ContactBookObject),
  ContactObject,
  ContactPage: pageOf(ContactObject),
  ImportContactsResult,
  UnsubscribeResult,
```

4. Add `{ name: "Contacts" },` to `tags`, after `{ name: "Templates" }`.

5. Add these entries to `paths`, after `/templates/{slug}/render`:

```ts
    "/contact-books": {
      get: op("Contacts", "listContactBooks", "List contact books", {
        parameters: pageParams,
        responses: {
          "200": json(ref("ContactBookPage"), "Page of contact books"),
          ...errors(...common, "validation_error"),
        },
      }),
      post: op("Contacts", "createContactBook", "Create a contact book", {
        requestBody: body("CreateContactBookInput"),
        responses: {
          "201": json(ref("ContactBookObject"), "Contact book"),
          ...errors(...common, "validation_error"),
        },
      }),
    },
    "/contact-books/{id}": {
      get: op("Contacts", "getContactBook", "Get a contact book", {
        parameters: [idParam()],
        responses: {
          "200": json(ref("ContactBookObject"), "Contact book"),
          ...errors(...common, "not_found"),
        },
      }),
      patch: op("Contacts", "updateContactBook", "Update a contact book", {
        parameters: [idParam()],
        requestBody: body("UpdateContactBookInput"),
        responses: {
          "200": json(ref("ContactBookObject"), "Updated contact book"),
          ...errors(...common, "validation_error", "not_found"),
        },
      }),
      delete: op("Contacts", "deleteContactBook", "Delete a contact book", {
        description:
          "Deletes every contact in the book. There is no undo, so this needs a key whose team role can manage settings.",
        parameters: [idParam()],
        responses: {
          "204": { description: "Deleted" },
          ...errors(...common, "not_found"),
        },
      }),
    },
    "/contact-books/{id}/contacts": {
      get: op("Contacts", "listContacts", "List contacts in a book", {
        description: "Newest first. `q` matches an address prefix or either name.",
        parameters: [
          ...pageParams,
          { name: "q", in: "query", schema: { type: "string" } },
          {
            name: "subscribed",
            in: "query",
            description: "Filter by consent.",
            schema: { type: "string", enum: ["true", "false"] },
          },
        ],
        responses: {
          "200": json(ref("ContactPage"), "Page of contacts"),
          ...errors(...common, "validation_error"),
        },
      }),
      post: op("Contacts", "createContact", "Add a contact to a book", {
        parameters: [idParam()],
        requestBody: body("CreateContactInput"),
        responses: {
          "201": json(ref("ContactObject"), "Contact"),
          ...errors(...common, "validation_error", "not_found", "conflict"),
        },
      }),
    },
    "/contact-books/{id}/contacts/{contactId}": {
      get: op("Contacts", "getContact", "Get a contact", {
        parameters: [idParam(), idParam("contactId")],
        responses: {
          "200": json(ref("ContactObject"), "Contact"),
          ...errors(...common, "not_found"),
        },
      }),
      patch: op("Contacts", "updateContact", "Update a contact", {
        description:
          "`subscribed: false` records consent withdrawal and stamps `unsubscribedAt`; `true` clears both. This is not the suppression list.",
        parameters: [idParam(), idParam("contactId")],
        requestBody: body("UpdateContactInput"),
        responses: {
          "200": json(ref("ContactObject"), "Updated contact"),
          ...errors(...common, "validation_error", "not_found"),
        },
      }),
      delete: op("Contacts", "deleteContact", "Delete a contact", {
        parameters: [idParam(), idParam("contactId")],
        responses: {
          "204": { description: "Deleted" },
          ...errors(...common, "not_found"),
        },
      }),
    },
    "/contact-books/{id}/contacts/import": {
      post: op("Contacts", "importContacts", "Import contacts from CSV", {
        description:
          "The CSV needs an `email` column; `first_name` and `last_name` are recognised and every other column becomes a property. Up to 2 MB and 10 000 rows per call — import a bigger list in chunks. Bad rows are reported in `errors` and do not fail the import; duplicate addresses inside one file collapse to the last occurrence.",
        parameters: [idParam()],
        requestBody: body("ImportContactsInput"),
        responses: {
          "200": json(ref("ImportContactsResult"), "Import counts and per-row errors"),
          ...errors(...common, "validation_error", "not_found", "payload_too_large"),
        },
      }),
    },
    "/contacts/unsubscribe": {
      post: op("Contacts", "unsubscribeContact", "Unsubscribe an address", {
        description:
          "Records consent withdrawal for an address across every book of the team, or one book with `bookId`. Idempotent. **This is not the suppression list**: it does not stop transactional mail — use `POST /suppressions` for that.",
        requestBody: body("UnsubscribeContactInput"),
        responses: {
          "200": json(ref("UnsubscribeResult"), "How many contacts changed"),
          ...errors(...common, "validation_error"),
        },
      }),
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/shared && bunx vitest run`
Run: `cd apps/web && bunx vitest run --project unit tests/unit/openapi-coverage.test.ts`
Run: `cd apps/web && bunx vitest run --project integration tests/integration/rest-contacts.test.ts`
Expected: PASS.

- [ ] **Step 6: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`

```bash
git add packages/shared apps/web
git commit -m "feat(api): contact book, contact, import and unsubscribe endpoints"
```

---

## Task 11: SDK — `templates`, `contactBooks` and `contacts`

The SDK's public types are hand-written so the published `.d.ts` names neither `@sendsprite/shared` nor `zod` (`tests/dist.test.ts`), and `tests/types-parity.test.ts` pins them to the zod contracts at **compile time** — a passing vitest run is not parity evidence; `bun run typecheck` is.

**Files:**

- Create: `packages/sdk/src/resources/templates.ts`, `packages/sdk/src/resources/contact-books.ts`, `packages/sdk/src/resources/contacts.ts`
- Modify: `packages/sdk/src/types.ts`, `packages/sdk/src/index.ts`
- Test: `packages/sdk/tests/types-parity.test.ts` (extend), `packages/sdk/tests/resources.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `packages/sdk/tests/resources.test.ts` (it drives the client with a stub `fetch` and asserts method, path and body — reuse whatever that file names its helper; the block below assumes a `client(handler)` factory and a `calls` array, matching the existing tests):

```ts
describe("templates", () => {
  it("lists, gets, creates, updates, deletes and renders", async () => {
    const { ss, calls } = client(() => ({ ok: true, body: {} }));
    await ss.templates.list({ limit: 10 });
    await ss.templates.get("welcome");
    await ss.templates.create({
      slug: "welcome",
      name: "Welcome",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
    });
    await ss.templates.update("welcome", { name: "W" });
    await ss.templates.remove("welcome");
    await ss.templates.render("welcome", { name: "Mingu" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /templates?limit=10",
      "GET /templates/welcome",
      "POST /templates",
      "PATCH /templates/welcome",
      "DELETE /templates/welcome",
      "POST /templates/welcome/render",
    ]);
    expect(calls[5]!.body).toEqual({ variables: { name: "Mingu" } });
  });

  it("URL-encodes a slug", async () => {
    const { ss, calls } = client(() => ({ ok: true, body: {} }));
    await ss.templates.get("a/b");
    expect(calls[0]!.path).toBe("/templates/a%2Fb");
  });
});

describe("contactBooks and contacts", () => {
  it("walks the nested paths", async () => {
    const { ss, calls } = client(() => ({ ok: true, body: {} }));
    await ss.contactBooks.list();
    await ss.contactBooks.create({ name: "News" });
    await ss.contactBooks.get("cb_1");
    await ss.contactBooks.update("cb_1", { name: "N" });
    await ss.contactBooks.remove("cb_1");
    await ss.contactBooks.import("cb_1", { csv: "email\na@b.io" });
    await ss.contacts.list("cb_1", { q: "ada" });
    await ss.contacts.create("cb_1", { email: "a@b.io" });
    await ss.contacts.get("cb_1", "ct_1");
    await ss.contacts.update("cb_1", "ct_1", { subscribed: false });
    await ss.contacts.remove("cb_1", "ct_1");
    await ss.contacts.unsubscribe({ email: "a@b.io" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /contact-books",
      "POST /contact-books",
      "GET /contact-books/cb_1",
      "PATCH /contact-books/cb_1",
      "DELETE /contact-books/cb_1",
      "POST /contact-books/cb_1/contacts/import",
      "GET /contact-books/cb_1/contacts?q=ada",
      "POST /contact-books/cb_1/contacts",
      "GET /contact-books/cb_1/contacts/ct_1",
      "PATCH /contact-books/cb_1/contacts/ct_1",
      "DELETE /contact-books/cb_1/contacts/ct_1",
      "POST /contacts/unsubscribe",
    ]);
  });

  it("iterates every page of contacts", async () => {
    let page = 0;
    const { ss } = client(() =>
      page++ === 0
        ? { ok: true, body: { data: [{ id: "ct_1" }], nextCursor: "c" } }
        : { ok: true, body: { data: [{ id: "ct_2" }], nextCursor: null } },
    );
    const seen: string[] = [];
    for await (const c of ss.contacts.iterate("cb_1")) seen.push(c.id);
    expect(seen).toEqual(["ct_1", "ct_2"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sdk && bunx vitest run tests/resources.test.ts`
Expected: FAIL — `ss.templates` is undefined.

- [ ] **Step 3: Add the public types**

Append to `packages/sdk/src/types.ts`, after the suppressions block:

```ts
// ---- templates --------------------------------------------------------------

export type TemplateVariableType = "string" | "number" | "boolean";

/** One declared variable. A `default` is what makes a placeholder optional. */
export interface TemplateVariable {
  name: string;
  /** Default `"string"`. */
  type?: TemplateVariableType;
  /** Default `true`. */
  required?: boolean;
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
  variablesSchema: { variables: Required<TemplateVariable>[] };
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
    variablesSchema: { variables: Required<TemplateVariable>[] };
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
  unsubscribed: number;
}
```

- [ ] **Step 4: Write the three resources**

`packages/sdk/src/resources/templates.ts`:

```ts
import type { HttpClient } from "../client";
import type {
  CreateTemplateInput,
  Page,
  PageParams,
  RenderedTemplateObject,
  TemplateDetail,
  TemplateObject,
  UpdateTemplateInput,
} from "../types";
import { enc } from "./emails";

export class Templates {
  constructor(private readonly http: HttpClient) {}

  list(params: PageParams = {}): Promise<Page<TemplateObject>> {
    return this.http.request("GET", "/templates", {
      query: { limit: params.limit, cursor: params.cursor },
    });
  }

  async *iterate(): AsyncGenerator<TemplateObject, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ cursor });
      yield* page.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  /** By slug or by `tpl_…` id; includes the version history. */
  get(slug: string): Promise<TemplateDetail> {
    return this.http.request("GET", `/templates/${enc(slug)}`);
  }

  create(input: CreateTemplateInput): Promise<TemplateObject> {
    return this.http.request("POST", "/templates", { body: input });
  }

  update(slug: string, input: UpdateTemplateInput): Promise<TemplateObject> {
    return this.http.request("PATCH", `/templates/${enc(slug)}`, {
      body: input,
    });
  }

  remove(slug: string): Promise<void> {
    return this.http.request("DELETE", `/templates/${enc(slug)}`);
  }

  /**
   * Renders without sending — byte-identical to what a send would store, so
   * this is a safe preview. Retried like a read: it changes nothing.
   */
  render(
    slug: string,
    variables: Record<string, unknown> = {},
  ): Promise<RenderedTemplateObject> {
    return this.http.request("POST", `/templates/${enc(slug)}/render`, {
      body: { variables },
      retry: true,
    });
  }
}
```

`packages/sdk/src/resources/contact-books.ts`:

```ts
import type { HttpClient } from "../client";
import type {
  ContactBookObject,
  CreateContactBookInput,
  ImportContactsInput,
  ImportContactsResult,
  Page,
  PageParams,
  UpdateContactBookInput,
} from "../types";
import { enc } from "./emails";

export class ContactBooks {
  constructor(private readonly http: HttpClient) {}

  list(params: PageParams = {}): Promise<Page<ContactBookObject>> {
    return this.http.request("GET", "/contact-books", {
      query: { limit: params.limit, cursor: params.cursor },
    });
  }

  get(id: string): Promise<ContactBookObject> {
    return this.http.request("GET", `/contact-books/${enc(id)}`);
  }

  create(input: CreateContactBookInput): Promise<ContactBookObject> {
    return this.http.request("POST", "/contact-books", { body: input });
  }

  update(
    id: string,
    input: UpdateContactBookInput,
  ): Promise<ContactBookObject> {
    return this.http.request("PATCH", `/contact-books/${enc(id)}`, {
      body: input,
    });
  }

  /** Deletes every contact in the book. */
  remove(id: string): Promise<void> {
    return this.http.request("DELETE", `/contact-books/${enc(id)}`);
  }

  /**
   * CSV import. Up to 2 MB and 10 000 rows per call — split a bigger list.
   * Not retried: a partial import repeated is an upsert, but the counts in the
   * first response would then be wrong, which is worse than a visible failure.
   */
  import(
    id: string,
    input: ImportContactsInput,
  ): Promise<ImportContactsResult> {
    return this.http.request(
      "POST",
      `/contact-books/${enc(id)}/contacts/import`,
      { body: input },
    );
  }
}
```

`packages/sdk/src/resources/contacts.ts`:

```ts
import type { HttpClient } from "../client";
import type {
  ContactObject,
  CreateContactInput,
  ListContactsParams,
  Page,
  UnsubscribeContactInput,
  UnsubscribeResult,
  UpdateContactInput,
} from "../types";
import { enc } from "./emails";

export class Contacts {
  constructor(private readonly http: HttpClient) {}

  private base(bookId: string): string {
    return `/contact-books/${enc(bookId)}/contacts`;
  }

  list(
    bookId: string,
    params: ListContactsParams = {},
  ): Promise<Page<ContactObject>> {
    return this.http.request("GET", this.base(bookId), {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        q: params.q,
        subscribed:
          params.subscribed === undefined
            ? undefined
            : String(params.subscribed),
      },
    });
  }

  async *iterate(
    bookId: string,
    params: Omit<ListContactsParams, "cursor"> = {},
  ): AsyncGenerator<ContactObject, void, undefined> {
    let cursor: string | undefined;
    do {
      const page = await this.list(bookId, { ...params, cursor });
      yield* page.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  get(bookId: string, id: string): Promise<ContactObject> {
    return this.http.request("GET", `${this.base(bookId)}/${enc(id)}`);
  }

  create(bookId: string, input: CreateContactInput): Promise<ContactObject> {
    return this.http.request("POST", this.base(bookId), { body: input });
  }

  update(
    bookId: string,
    id: string,
    input: UpdateContactInput,
  ): Promise<ContactObject> {
    return this.http.request("PATCH", `${this.base(bookId)}/${enc(id)}`, {
      body: input,
    });
  }

  remove(bookId: string, id: string): Promise<void> {
    return this.http.request("DELETE", `${this.base(bookId)}/${enc(id)}`);
  }

  /**
   * Records consent withdrawal for an address across every book of the team
   * (or one, with `bookId`). Idempotent, so it is safe to retry.
   *
   * This is **not** the suppression list: it does not stop transactional mail.
   * Use `suppressions.add()` for that.
   */
  unsubscribe(input: UnsubscribeContactInput): Promise<UnsubscribeResult> {
    return this.http.request("POST", "/contacts/unsubscribe", {
      body: input,
      retry: true,
    });
  }
}
```

- [ ] **Step 5: Wire the namespaces**

In `packages/sdk/src/index.ts`, add to the type re-exports:

```ts
export type { Templates } from "./resources/templates";
export type { ContactBooks } from "./resources/contact-books";
export type { Contacts } from "./resources/contacts";
```

add to the value imports:

```ts
import { ContactBooks } from "./resources/contact-books";
import { Contacts } from "./resources/contacts";
import { Templates } from "./resources/templates";
```

and inside the class:

```ts
  readonly templates: Templates;
  readonly contactBooks: ContactBooks;
  readonly contacts: Contacts;
```

```ts
this.templates = new Templates(this.http);
this.contactBooks = new ContactBooks(this.http);
this.contacts = new Contacts(this.http);
```

- [ ] **Step 6: Extend the parity test**

In `packages/sdk/tests/types-parity.test.ts`, add these 20 entries to the end of the `Checks` tuple (before the closing `];`):

```ts
  Mutual<sdk.TemplateVariableType, shared.TemplateVariableType>,
  Mutual<sdk.TemplateVariable, In<typeof shared.TemplateVariable>>,
  Mutual<sdk.TemplateVariablesSchema, In<typeof shared.TemplateVariablesSchema>>,
  Mutual<sdk.CreateTemplateInput, In<typeof shared.CreateTemplateInput>>,
  Mutual<sdk.UpdateTemplateInput, In<typeof shared.UpdateTemplateInput>>,
  Mutual<sdk.TemplateObject, Out<typeof shared.TemplateObject>>,
  Mutual<sdk.TemplateVersionObject, Out<typeof shared.TemplateVersionObject>>,
  Mutual<sdk.TemplateDetail, Out<typeof shared.TemplateDetail>>,
  Mutual<sdk.RenderTemplateInput, In<typeof shared.RenderTemplateInput>>,
  Mutual<sdk.RenderedTemplateObject, Out<typeof shared.RenderedTemplateObject>>,
  Mutual<sdk.CreateContactBookInput, In<typeof shared.CreateContactBookInput>>,
  Mutual<sdk.UpdateContactBookInput, In<typeof shared.UpdateContactBookInput>>,
  Mutual<sdk.ContactBookObject, Out<typeof shared.ContactBookObject>>,
  Mutual<sdk.CreateContactInput, In<typeof shared.CreateContactInput>>,
  Mutual<sdk.UpdateContactInput, In<typeof shared.UpdateContactInput>>,
  Mutual<sdk.ContactObject, Out<typeof shared.ContactObject>>,
  Mutual<Required<sdk.ListContactsParams>, Required<Out<typeof shared.ListContactsQuery>>>,
  Mutual<sdk.ImportContactsInput, In<typeof shared.ImportContactsInput>>,
  Mutual<sdk.ImportContactsResult, Out<typeof shared.ImportContactsResult>>,
  Mutual<sdk.UnsubscribeContactInput, In<typeof shared.UnsubscribeContactInput>>,
```

and append **20** more `true,` entries to the `allTrue` array, so it holds **55** in total (35 before this task, 20 added). The annotation `const allTrue: Checks = [...]` fails to compile if the counts disagree, which is the point.

Then add this runtime enum check inside the existing `it("enum unions match the shared constant arrays", …)`:

```ts
const variableTypes: Record<sdk.TemplateVariableType, true> = {
  string: true,
  number: true,
  boolean: true,
};
expect(Object.keys(variableTypes).sort()).toEqual(
  [...shared.TEMPLATE_VARIABLE_TYPES].sort(),
);
```

Also add one more `UnsubscribeResult` check to the tuple if `bun run typecheck` reports it unused — it is intentionally omitted above because `{ unsubscribed: number }` has no shape to drift.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd packages/sdk && bunx vitest run`
Run (**the real parity gate**): `bun run typecheck`
Expected: PASS. If `types-parity.test.ts` fails to compile, a hand-written type has drifted from its zod contract — fix the type, never the tuple.

- [ ] **Step 8: Confirm the published artefact is still clean**

Run: `cd packages/sdk && bunx vitest run tests/dist.test.ts`
Expected: PASS — no `@sendsprite/shared`, `zod` or `react` specifier in any `.d.ts`, and none in `cli.js`.

- [ ] **Step 9: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add packages/sdk
git commit -m "feat(sdk): templates, contactBooks and contacts namespaces"
```

---

## Task 12: CLI — `templates pull|push <dir>`

Templates as files in a repository: `pull` writes them out, `push` sends them back. One `registerTemplates` entry in `COMMANDS` and nothing else changes.

**Layout.** Flat, three files per template, so a diff shows HTML as HTML:

```
<dir>/welcome.json    { "name", "subject", "variablesSchema" }
<dir>/welcome.html    the bodyHtml
<dir>/welcome.txt     the bodyText (absent when the template has none)
```

**The CLI never imports `@sendsprite/shared`** — `tests/dist.test.ts` forbids the specifier in `dist/cli.js` — so it validates slugs with its own small regex rather than reusing `TemplateSlug`.

**Files:**

- Create: `packages/sdk/src/cli/commands/templates.ts`
- Modify: `packages/sdk/src/cli/index.ts`
- Test: `packages/sdk/tests/cli.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/sdk/tests/cli.test.ts` (it builds the program with stub deps and captures `write`; reuse whatever that file names its helpers — the block below assumes a `run(argv, { client })` helper and a `lines` array, matching the existing tests):

```ts
describe("templates pull/push", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "sendsprite-cli-templates-"));

  const template = {
    id: "tpl_1",
    slug: "welcome",
    name: "Welcome",
    subject: "Hi {{name}}",
    bodyHtml: "<p>Hi {{name}}</p>",
    bodyText: "Hi {{name}}",
    variablesSchema: { variables: [] },
    version: 1,
    updatedBy: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    versions: [],
  };

  it("pulls every template into three files", async () => {
    const out = dir();
    const client = {
      templates: {
        list: async () => ({ data: [template], nextCursor: null }),
        get: async () => template,
      },
    };
    const { lines } = await run(["templates", "pull", out], { client });
    expect(readFileSync(join(out, "welcome.html"), "utf8")).toBe(
      "<p>Hi {{name}}</p>",
    );
    expect(readFileSync(join(out, "welcome.txt"), "utf8")).toBe("Hi {{name}}");
    expect(JSON.parse(readFileSync(join(out, "welcome.json"), "utf8"))).toEqual(
      {
        name: "Welcome",
        subject: "Hi {{name}}",
        variablesSchema: { variables: [] },
      },
    );
    expect(lines.join("\n")).toMatch(/1 template/);
  });

  it("omits the .txt file for a template with no text body", async () => {
    const out = dir();
    const client = {
      templates: {
        list: async () => ({
          data: [{ ...template, bodyText: null }],
          nextCursor: null,
        }),
      },
    };
    await run(["templates", "pull", out], { client });
    expect(existsSync(join(out, "welcome.txt"))).toBe(false);
  });

  it("pushes: creates what is missing and patches what exists", async () => {
    const out = dir();
    writeFileSync(
      join(out, "welcome.json"),
      JSON.stringify({ name: "Welcome", subject: "Hi" }),
    );
    writeFileSync(join(out, "welcome.html"), "<p>Hi</p>");
    writeFileSync(
      join(out, "second.json"),
      JSON.stringify({ name: "Second", subject: "Yo" }),
    );
    writeFileSync(join(out, "second.html"), "<p>Yo</p>");
    const calls: string[] = [];
    const client = {
      templates: {
        get: async (slug: string) => {
          if (slug === "welcome") return template;
          const e = new Error("not found") as Error & {
            name: string;
            code: string;
          };
          e.name = "SendspriteError";
          e.code = "not_found";
          throw e;
        },
        create: async (input: { slug: string }) => {
          calls.push(`create ${input.slug}`);
          return template;
        },
        update: async (slug: string) => {
          calls.push(`update ${slug}`);
          return template;
        },
      },
    };
    await run(["templates", "push", out], { client });
    expect(calls.sort()).toEqual(["create second", "update welcome"]);
  });

  it("--dry-run touches nothing", async () => {
    const out = dir();
    writeFileSync(
      join(out, "a.json"),
      JSON.stringify({ name: "A", subject: "s" }),
    );
    writeFileSync(join(out, "a.html"), "<p>a</p>");
    const calls: string[] = [];
    const client = {
      templates: {
        get: async () => {
          const e = new Error("no") as Error & { name: string; code: string };
          e.name = "SendspriteError";
          e.code = "not_found";
          throw e;
        },
        create: async () => {
          calls.push("create");
          return template;
        },
      },
    };
    const { lines } = await run(["templates", "push", out, "--dry-run"], {
      client,
    });
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toMatch(/would create a/);
  });

  it("refuses a json file with no matching .html and a name that is not a slug", async () => {
    const out = dir();
    writeFileSync(
      join(out, "orphan.json"),
      JSON.stringify({ name: "O", subject: "s" }),
    );
    await expect(
      run(["templates", "push", out], { client: {} }),
    ).rejects.toThrow(/orphan\.html/);
    const bad = dir();
    writeFileSync(join(bad, "Not A Slug.json"), "{}");
    await expect(
      run(["templates", "push", bad], { client: {} }),
    ).rejects.toThrow(/slug/i);
  });
});
```

Add the node imports this block needs to the top of `packages/sdk/tests/cli.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sdk && bunx vitest run tests/cli.test.ts`
Expected: FAIL — `templates` is not a command.

- [ ] **Step 3: Write `packages/sdk/src/cli/commands/templates.ts`**

```ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CreateTemplateInput, TemplateObject } from "../../types";
import type { CommandContext } from "../index";

/**
 * `sendsprite templates pull|push <dir>` — templates as files in a repo.
 *
 * Three files per template so a diff shows HTML as HTML:
 *   <slug>.json   { name, subject, variablesSchema }
 *   <slug>.html   the bodyHtml
 *   <slug>.txt    the bodyText, when there is one
 *
 * This module must not import `@sendsprite/shared`: `tests/dist.test.ts`
 * forbids that specifier in the published `cli.js`. Hence the local slug rule.
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

interface Manifest {
  name: string;
  subject: string;
  variablesSchema?: CreateTemplateInput["variablesSchema"];
}

export function registerTemplates({
  program,
  client,
  write,
  run,
}: CommandContext) {
  const templates = program
    .command("templates")
    .description("Templates as files")
    .exitOverride();

  templates
    .command("pull")
    .argument("<dir>", "Directory to write into (created if absent)")
    .description("Write every template in the team to <dir>")
    .option("--dry-run", "List what would be written and change nothing")
    .action(
      run(async (dir: string, opts: { dryRun?: boolean }) => {
        const api = client();
        const all: TemplateObject[] = [];
        let cursor: string | undefined;
        do {
          const page = await api.templates.list({ limit: 100, cursor });
          all.push(...page.data);
          cursor = page.nextCursor ?? undefined;
        } while (cursor);

        if (!opts.dryRun) mkdirSync(dir, { recursive: true });
        for (const t of all) {
          // The slug becomes three file names. A server that returned
          // "../../etc/passwd" must not get to write there.
          if (!SLUG_RE.test(t.slug))
            throw new Error(
              `Refusing to write template with an unexpected slug: ${t.slug}`,
            );
          const manifest: Manifest = {
            name: t.name,
            subject: t.subject,
            variablesSchema: t.variablesSchema,
          };
          write(`${opts.dryRun ? "would write" : "wrote"} ${t.slug}`);
          if (opts.dryRun) continue;
          writeFileSync(
            join(dir, `${t.slug}.json`),
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
          writeFileSync(join(dir, `${t.slug}.html`), t.bodyHtml);
          if (t.bodyText !== null)
            writeFileSync(join(dir, `${t.slug}.txt`), t.bodyText);
        }
        write(`${all.length} template${all.length === 1 ? "" : "s"}`);
      }),
    );

  templates
    .command("push")
    .argument("<dir>", "Directory holding <slug>.json / .html / .txt")
    .description("Create or update every template found in <dir>")
    .option("--dry-run", "Report what would change and send nothing")
    .action(
      run(async (dir: string, opts: { dryRun?: boolean }) => {
        const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
        // Read and validate everything before sending anything: a directory
        // with one broken file must not leave half of it pushed.
        const pending = files.map((file) => {
          const slug = file.slice(0, -".json".length);
          if (!SLUG_RE.test(slug))
            throw new Error(
              `${file}: "${slug}" is not a valid slug (lower-case letters, digits and dashes).`,
            );
          const htmlPath = join(dir, `${slug}.html`);
          if (!existsSync(htmlPath))
            throw new Error(`${file}: no matching ${slug}.html.`);
          const manifest = JSON.parse(
            readFileSync(join(dir, file), "utf8"),
          ) as Manifest;
          if (!manifest.name || !manifest.subject)
            throw new Error(`${file}: "name" and "subject" are required.`);
          const textPath = join(dir, `${slug}.txt`);
          return {
            slug,
            input: {
              slug,
              name: manifest.name,
              subject: manifest.subject,
              bodyHtml: readFileSync(htmlPath, "utf8"),
              ...(existsSync(textPath)
                ? { bodyText: readFileSync(textPath, "utf8") }
                : {}),
              ...(manifest.variablesSchema
                ? { variablesSchema: manifest.variablesSchema }
                : {}),
            } satisfies CreateTemplateInput,
          };
        });

        const api = client();
        for (const { slug, input } of pending) {
          const exists = await api.templates
            .get(slug)
            .then(() => true)
            .catch((cause: unknown) => {
              if ((cause as { code?: string }).code === "not_found")
                return false;
              throw cause;
            });
          const verb = exists ? "update" : "create";
          if (opts.dryRun) {
            write(`would ${verb} ${slug}`);
            continue;
          }
          if (exists) {
            const { slug: _slug, ...patch } = input;
            await api.templates.update(slug, patch);
          } else await api.templates.create(input);
          write(`${verb}d ${slug}`);
        }
        write(`${pending.length} template${pending.length === 1 ? "" : "s"}`);
      }),
    );
}
```

- [ ] **Step 4: Register the command**

In `packages/sdk/src/cli/index.ts`, add the import and the registry entry, and replace the stale comment above `COMMANDS`:

```ts
import { registerTemplates } from "./commands/templates";
```

```ts
/** The command registry. A new command is one entry here and one file. */
const COMMANDS: readonly ((ctx: CommandContext) => void)[] = [
  registerLogin,
  registerWhoami,
  registerDomains,
  registerEmails,
  registerTemplates,
];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/sdk && bunx vitest run`
Expected: PASS.

- [ ] **Step 6: Confirm the built CLI is still clean and still self-describes**

Run: `cd packages/sdk && bunx vitest run tests/dist.test.ts`
Expected: PASS. `dist.test.ts` asserts `--help` lists `login`, `whoami`, `domains`, `emails`; add `"templates"` to that list in the same test so the new command is covered:

```ts
for (const command of ["login", "whoami", "domains", "emails", "templates"]) {
  expect(help.stdout).toContain(command);
}
```

- [ ] **Step 7: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add packages/sdk
git commit -m "feat(cli): templates pull and push"
```

---

## Task 13: MCP — `list_templates`, `render_template`, `add_contact`

Three tools appended to the `TOOLS` registry, in the shape `tools/list-domains.ts` and `tools/send-email.ts` established: loose output schemas, `toolResult` / `toolError`, failures as `isError` results rather than protocol errors.

**Files:**

- Create: `packages/mcp/src/tools/list-templates.ts`, `packages/mcp/src/tools/render-template.ts`, `packages/mcp/src/tools/add-contact.ts`
- Modify: `packages/mcp/src/tools/output.ts`, `packages/mcp/src/server.ts`
- Test: `packages/mcp/tests/server.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `packages/mcp/tests/server.test.ts` (it connects the server to an in-memory transport against a stub client; reuse whatever that file names its helpers — the block below assumes a `connect(stubClient)` returning an MCP `client`):

```ts
describe("phase 6 tools", () => {
  it("advertises the three new tools", async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "list_templates",
        "render_template",
        "add_contact",
      ]),
    );
  });

  it("list_templates returns the page envelope", async () => {
    const { client } = await connect({
      templates: {
        list: async () => ({
          data: [{ id: "tpl_1", slug: "welcome" }],
          nextCursor: null,
        }),
      },
    });
    const res = await client.callTool({
      name: "list_templates",
      arguments: {},
    });
    expect(res.structuredContent).toMatchObject({
      data: [{ id: "tpl_1" }],
      nextCursor: null,
    });
  });

  it("render_template passes the variables through and returns the rendered fields", async () => {
    let seen: unknown;
    const { client } = await connect({
      templates: {
        render: async (slug: string, variables: unknown) => {
          seen = { slug, variables };
          return { subject: "Hi Mingu", html: "<p>Hi Mingu</p>", text: null };
        },
      },
    });
    const res = await client.callTool({
      name: "render_template",
      arguments: { slug: "welcome", variables: { name: "Mingu" } },
    });
    expect(seen).toEqual({ slug: "welcome", variables: { name: "Mingu" } });
    expect(res.structuredContent).toMatchObject({ subject: "Hi Mingu" });
  });

  it("add_contact posts into the named book", async () => {
    let seen: unknown;
    const { client } = await connect({
      contacts: {
        create: async (bookId: string, input: unknown) => {
          seen = { bookId, input };
          return { id: "ct_1", bookId, email: "a@b.io", subscribed: true };
        },
      },
    });
    const res = await client.callTool({
      name: "add_contact",
      arguments: { bookId: "cb_1", email: "a@b.io", firstName: "Ada" },
    });
    expect(seen).toEqual({
      bookId: "cb_1",
      input: { email: "a@b.io", firstName: "Ada" },
    });
    expect(res.structuredContent).toMatchObject({ id: "ct_1" });
  });

  it("reports an API refusal as an isError result, not a protocol error", async () => {
    const { client } = await connect({
      templates: {
        render: async () => {
          const e = new Error("Template variables missing: name.") as Error & {
            name: string;
            code: string;
            status: number;
          };
          e.name = "SendspriteError";
          e.code = "validation_error";
          e.status = 400;
          throw e;
        },
      },
    });
    const res = await client.callTool({
      name: "render_template",
      arguments: { slug: "welcome" },
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("validation_error");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/mcp && bunx vitest run`
Expected: FAIL — the three tools are not advertised.

- [ ] **Step 3: Add the two output schemas**

Append to `packages/mcp/src/tools/output.ts`:

```ts
export const renderedTemplateOutput = z.looseObject({
  subject: z.string(),
  html: z.string(),
  text: z.string().nullable(),
});

export const contactOutput = z.looseObject({
  id: z.string(),
  bookId: z.string(),
  email: z.string(),
  subscribed: z.boolean(),
});
```

- [ ] **Step 4: Write the three tools**

`packages/mcp/src/tools/list-templates.ts`:

```ts
import { pageOutput } from "./output";
import type { ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/**
 * No arguments: a team has a handful of templates and the answer the model
 * needs — "what can I send, and what does it want?" — is the whole list.
 */
export const registerListTemplates: ToolRegistration = (server, client) =>
  server.registerTool(
    "list_templates",
    {
      title: "List email templates",
      description:
        "List the email templates on this instance. Each carries a `slug` (pass it as `template` " +
        "to `send_email`), a `subject`, and a `variablesSchema` naming the `{{ variable }}` " +
        "placeholders its bodies use. Every placeholder must be supplied or the send is refused.",
      outputSchema: pageOutput,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return toolResult(await client.templates.list());
      } catch (e) {
        return toolError(e);
      }
    },
  );
```

`packages/mcp/src/tools/render-template.ts`:

```ts
import { z } from "zod";
import { renderedTemplateOutput } from "./output";
import type { ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/**
 * A dry run. Nothing is sent and nothing is stored, and the output is exactly
 * what `send_email` with the same `template` and `variables` would store — so
 * a model can check its substitution before it sends to a person.
 */
export const registerRenderTemplate: ToolRegistration = (server, client) =>
  server.registerTool(
    "render_template",
    {
      title: "Render a template",
      description:
        "Preview a template with a set of variables. Nothing is sent. The result is byte-identical " +
        "to what `send_email` would produce for the same input, so use it to check a substitution " +
        "first. A missing or non-scalar variable is an error naming it.",
      inputSchema: {
        slug: z.string().describe("Template slug, from `list_templates`."),
        variables: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Values for the `{{ variable }}` placeholders."),
      },
      outputSchema: renderedTemplateOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ slug, variables }) => {
      try {
        return toolResult(await client.templates.render(slug, variables));
      } catch (e) {
        return toolError(e);
      }
    },
  );
```

`packages/mcp/src/tools/add-contact.ts`:

```ts
import { z } from "zod";
import { contactOutput } from "./output";
import { compact } from "./register";
import type { ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/**
 * Adds one person to one contact book. Subscription is **consent**, not
 * deliverability: a contact does not stop transactional mail, and this tool
 * cannot suppress an address.
 */
export const registerAddContact: ToolRegistration = (server, client) =>
  server.registerTool(
    "add_contact",
    {
      title: "Add a contact to a book",
      description:
        "Add one person to a contact book. `bookId` is a `cb_…` id. The address must be unique " +
        "within the book. Contacts record consent for campaigns; they do not affect transactional " +
        "sends, and adding one never sends anything.",
      inputSchema: {
        bookId: z.string().describe("Contact book id (`cb_…`)."),
        email: z.string().describe("The person's email address."),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        properties: z
          .record(z.string(), z.string())
          .optional()
          .describe("Up to 20 custom string properties."),
      },
      outputSchema: contactOutput,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ bookId, ...rest }) => {
      try {
        const c = await client.contacts.create(bookId, compact(rest));
        // Only the advertised fields: the output schema is what clients
        // validate against, so passing the response through verbatim would
        // break them the day the REST object grows a key.
        return toolResult({
          id: c.id,
          bookId: c.bookId,
          email: c.email,
          subscribed: c.subscribed,
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );
```

- [ ] **Step 5: Register them**

In `packages/mcp/src/server.ts`, add the imports and replace the `TOOLS` array and the stale Phase 5 comment:

```ts
import { registerAddContact } from "./tools/add-contact";
import { registerListTemplates } from "./tools/list-templates";
import { registerRenderTemplate } from "./tools/render-template";
```

```ts
/**
 * The registry. Order is the order tools are advertised in `tools/list`, so
 * the ones a model reaches for first come first.
 */
const TOOLS: ToolRegistration[] = [
  registerSendEmail,
  registerGetEmailStatus,
  registerListEmails,
  registerSearchEmails,
  registerListDomains,
  registerListTemplates,
  registerRenderTemplate,
  registerGetSendStats,
  registerAddContact,
];
```

and extend the server `instructions` string so a model knows templates exist:

```ts
      instructions:
        "Tools for a Sendsprite instance: send transactional email, track what happened to it, " +
        "and inspect sending domains, templates and deliverability. Check `list_domains` before " +
        "sending from an unfamiliar address — only verified domains are allowed — and " +
        "`list_templates` before naming a template, since every `{{ variable }}` it uses must be " +
        "supplied.",
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd packages/mcp && bunx vitest run`
Expected: PASS.

- [ ] **Step 7: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add packages/mcp
git commit -m "feat(mcp): list_templates, render_template and add_contact tools"
```

---

## Task 14: Dashboard — `/app/templates`

`AppShell`'s `NAV` has linked `/app/templates` at a 404 since Phase 1. This makes it real: a list, an editor with a live preview that uses the same renderer the server does, and version history with restore.

**On "variable autocomplete" (spec §10).** There is no code-editor component in the UI kit and this phase does not add one, so autocomplete is delivered as what a `<textarea>` can honestly do: an **Insert** chip per declared variable that writes `{{name}}` at the cursor, plus a live list of placeholders the body uses that are **not** declared. That is the part with real value — an undeclared placeholder is a send that will be refused — and it is recorded as an opener that inline completion wants a proper editor.

**Files:**

- Create: `apps/web/src/app/app/templates/page.tsx`, `.../actions.ts`, `.../TemplateList.tsx`, `.../new/page.tsx`, `.../[slug]/page.tsx`, `.../[slug]/TemplateEditor.tsx`

- [ ] **Step 1: Write the server actions**

`apps/web/src/app/app/templates/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { requestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { requireTeam } from "@/lib/session";
import * as templates from "@/services/templates";

export type { Result } from "@/lib/result";

/** Server actions are thin: resolve the actor, delegate, revalidate. */
async function actor() {
  const ctx = await requireTeam();
  return {
    userId: ctx.userId,
    teamId: ctx.team.id,
    teamName: ctx.team.name,
    role: ctx.role,
    meta: requestMeta(await headers()),
  };
}

export interface TemplateDraft {
  slug?: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  variablesSchema: { variables: { name: string; default?: string }[] };
}

export async function createTemplate(
  draft: TemplateDraft,
): Promise<Result<{ slug: string }>> {
  const res = await templates.createTemplate(await actor(), {
    ...draft,
    // An empty textarea means "no text body", not "an empty one".
    bodyText: draft.bodyText.trim() ? draft.bodyText : undefined,
  });
  if (!res.ok) return res;
  revalidatePath("/app/templates");
  return { ok: true, data: { slug: res.data.slug } };
}

export async function updateTemplate(
  slug: string,
  draft: TemplateDraft,
): Promise<Result> {
  const res = await templates.updateTemplate(await actor(), slug, {
    name: draft.name,
    subject: draft.subject,
    bodyHtml: draft.bodyHtml,
    bodyText: draft.bodyText.trim() ? draft.bodyText : null,
    variablesSchema: draft.variablesSchema,
  });
  if (!res.ok) return res;
  revalidatePath(`/app/templates/${slug}`);
  revalidatePath("/app/templates");
  return { ok: true, data: undefined };
}

export async function deleteTemplate(slug: string): Promise<Result> {
  const res = await templates.deleteTemplate(await actor(), slug);
  if (res.ok) revalidatePath("/app/templates");
  return res;
}

/**
 * Restoring is an ordinary update carrying an old snapshot's fields, so it
 * appends a new version rather than rewinding history — the record of what
 * was live and when stays complete.
 */
export async function restoreVersion(
  slug: string,
  version: number,
): Promise<Result> {
  const a = await actor();
  const found = (
    await templates.listTemplateVersions(a.teamId, slug, 100)
  ).find((v) => v.version === version);
  if (!found)
    return { ok: false, code: "not_found", error: "That version is gone." };
  const res = await templates.updateTemplate(a, slug, found.snapshot);
  if (res.ok) revalidatePath(`/app/templates/${slug}`);
  return res.ok ? { ok: true, data: undefined } : res;
}
```

- [ ] **Step 2: Write the list page and its panel**

`apps/web/src/app/app/templates/page.tsx`:

```tsx
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { listTemplates } from "@/services/templates";
import { TemplateList, type TemplateRow } from "./TemplateList";

export const metadata = { title: "Templates" };

export default async function TemplatesPage() {
  const ctx = await requireTeam();
  const rows: TemplateRow[] = (await listTemplates(ctx.team.id)).map((t) => ({
    slug: t.slug,
    name: t.name,
    subject: t.subject,
    version: t.version,
    updated: formatWhen(t.updatedAt),
  }));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="num-stamp">Templates</p>
        <Button asChild>
          <Link href="/app/templates/new">New template</Link>
        </Button>
      </div>
      <TemplateList templates={rows} role={ctx.role} />
    </div>
  );
}
```

`apps/web/src/app/app/templates/TemplateList.tsx`:

```tsx
"use client";
import NextLink from "next/link";
import { useState, useTransition } from "react";
import { can, type TeamRole } from "@sendsprite/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { deleteTemplate, type Result } from "./actions";

/** Dates are pre-formatted on the server so SSR and hydration agree. */
export type TemplateRow = {
  slug: string;
  name: string;
  subject: string;
  version: number;
  updated: string;
};

export function TemplateList({
  templates,
  role,
}: {
  templates: TemplateRow[];
  role: TeamRole;
}) {
  const canManage = can(role, "templates.manage");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = (t: TemplateRow) => {
    if (!window.confirm(`Delete the template "${t.slug}"? Sends that name it will fail.`))
      return;
    start(async () => {
      setError(null);
      const res: Result = await deleteTemplate(t.slug);
      if (!res.ok) setError(res.error);
    });
  };

  if (templates.length === 0)
    return (
      <EmptyState
        title="No templates yet"
        body="A template holds a subject and a body with {{variable}} placeholders. Send one with `template: \"slug\"` instead of html."
        action={
          canManage ? (
            <Button asChild>
              <NextLink href="/app/templates/new">New template</NextLink>
            </Button>
          ) : undefined
        }
      />
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="glass overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="num-stamp text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Slug</th>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Subject</th>
              <th className="px-4 py-3 font-medium">Version</th>
              <th className="px-4 py-3 font-medium">Updated</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.slug} className="border-t border-white/8">
                <td className="px-4 py-3 font-medium">
                  <NextLink
                    href={`/app/templates/${t.slug}`}
                    className="underline decoration-white/30 underline-offset-2 hover:text-white"
                  >
                    <code className="text-xs">{t.slug}</code>
                  </NextLink>
                </td>
                <td className="px-4 py-3">{t.name}</td>
                <td className="px-4 py-3 text-white/65">{t.subject}</td>
                <td className="px-4 py-3">
                  <Badge variant="muted">v{t.version}</Badge>
                </td>
                <td className="px-4 py-3 text-white/65">{t.updated}</td>
                <td className="px-4 py-3 text-right">
                  {canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => remove(t)}
                    >
                      Delete
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Write the editor**

`apps/web/src/app/app/templates/[slug]/TemplateEditor.tsx`:

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import {
  placeholderNames,
  renderTemplate,
  slugifyTemplateName,
} from "@sendsprite/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Textarea } from "@/components/ui/Textarea";
import {
  createTemplate,
  restoreVersion,
  updateTemplate,
  type Result,
  type TemplateDraft,
} from "../actions";

export interface VersionRow {
  version: number;
  created: string;
}

export interface EditorTemplate {
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  variables: { name: string; default: string }[];
}

const EMPTY: EditorTemplate = {
  slug: "",
  name: "",
  subject: "",
  bodyHtml: "<p>Hello {{name}},</p>\n",
  bodyText: "",
  variables: [],
};

export function TemplateEditor({
  mode,
  template = EMPTY,
  versions = [],
  canManage,
}: {
  mode: "create" | "edit";
  template?: EditorTemplate;
  versions?: VersionRow[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [t, setT] = useState(template);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const htmlRef = useRef<HTMLTextAreaElement>(null);

  const set = <K extends keyof EditorTemplate>(k: K, v: EditorTemplate[K]) => {
    setSaved(false);
    setT((prev) => ({ ...prev, [k]: v }));
  };

  /** Every placeholder the three fields use, and which of them are declared. */
  const used = useMemo(
    () =>
      [
        ...new Set([
          ...placeholderNames(t.subject),
          ...placeholderNames(t.bodyHtml),
          ...placeholderNames(t.bodyText),
        ]),
      ].sort(),
    [t.subject, t.bodyHtml, t.bodyText],
  );
  const declared = useMemo(
    () => new Set(t.variables.map((v) => v.name)),
    [t.variables],
  );
  const undeclared = used.filter((n) => !declared.has(n));

  /**
   * The live preview runs the **same** `renderTemplate` the server runs, with
   * each variable's declared default or a visible stand-in — so what is shown
   * cannot differ from what a send would produce.
   */
  const preview = useMemo(() => {
    const values = Object.fromEntries(
      used.map((n) => [
        n,
        t.variables.find((v) => v.name === n)?.default || `{${n}}`,
      ]),
    );
    return renderTemplate(
      {
        subject: t.subject || " ",
        bodyHtml: t.bodyHtml,
        bodyText: t.bodyText || null,
      },
      values,
    );
  }, [t, used]);

  /** Writes `{{name}}` at the cursor of the HTML body. */
  const insert = (name: string) => {
    const el = htmlRef.current;
    const token = `{{${name}}}`;
    if (!el) return set("bodyHtml", t.bodyHtml + token);
    const at = el.selectionStart ?? t.bodyHtml.length;
    const end = el.selectionEnd ?? at;
    set("bodyHtml", t.bodyHtml.slice(0, at) + token + t.bodyHtml.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + token.length, at + token.length);
    });
  };

  const draft = (): TemplateDraft => ({
    ...(mode === "create"
      ? { slug: t.slug || slugifyTemplateName(t.name) }
      : {}),
    name: t.name,
    subject: t.subject,
    bodyHtml: t.bodyHtml,
    bodyText: t.bodyText,
    variablesSchema: {
      variables: t.variables
        .filter((v) => v.name)
        .map((v) => ({
          name: v.name,
          ...(v.default ? { default: v.default } : {}),
        })),
    },
  });

  const save = () =>
    start(async () => {
      setError(null);
      const res: Result<{ slug: string }> | Result =
        mode === "create"
          ? await createTemplate(draft())
          : await updateTemplate(t.slug, draft());
      if (!res.ok) return setError(res.error);
      setSaved(true);
      if (mode === "create")
        router.push(`/app/templates/${(res.data as { slug: string }).slug}`);
      else router.refresh();
    });

  const restore = (version: number) =>
    start(async () => {
      setError(null);
      const res = await restoreVersion(t.slug, version);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{mode === "create" ? "New template" : t.slug}</CardTitle>
          </CardHeader>
          <CardBody className="flex flex-col gap-4">
            <div>
              <Label htmlFor="tpl-name">Name</Label>
              <Input
                id="tpl-name"
                value={t.name}
                disabled={!canManage}
                onChange={(e) => set("name", e.target.value)}
              />
            </div>
            {mode === "create" && (
              <div>
                <Label htmlFor="tpl-slug">Slug</Label>
                <Input
                  id="tpl-slug"
                  value={t.slug}
                  placeholder={slugifyTemplateName(t.name) || "welcome"}
                  onChange={(e) => set("slug", e.target.value)}
                />
                <p className="mt-1 text-xs text-white/50">
                  The name you pass as <code>template</code> when sending. It
                  cannot be changed later.
                </p>
              </div>
            )}
            <div>
              <Label htmlFor="tpl-subject">Subject</Label>
              <Input
                id="tpl-subject"
                value={t.subject}
                disabled={!canManage}
                onChange={(e) => set("subject", e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="tpl-html">HTML body</Label>
              <Textarea
                id="tpl-html"
                ref={htmlRef}
                rows={14}
                className="font-mono text-xs"
                value={t.bodyHtml}
                disabled={!canManage}
                onChange={(e) => set("bodyHtml", e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="tpl-text">Plain-text body (optional)</Label>
              <Textarea
                id="tpl-text"
                rows={6}
                className="font-mono text-xs"
                value={t.bodyText}
                disabled={!canManage}
                onChange={(e) => set("bodyText", e.target.value)}
              />
            </div>
          </CardBody>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Variables</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {used.length === 0 && (
                  <p className="text-sm text-white/60">
                    Write <code>{"{{name}}"}</code> in the subject or body to
                    add one.
                  </p>
                )}
                {used.map((n) => (
                  <Button
                    key={n}
                    size="sm"
                    variant="ghost"
                    disabled={!canManage}
                    onClick={() => insert(n)}
                  >
                    Insert {"{{"}
                    {n}
                    {"}}"}
                  </Button>
                ))}
              </div>
              {undeclared.length > 0 && (
                <p role="alert" className="text-sm text-amber-300">
                  Not declared below, so a send that omits{" "}
                  {undeclared.length === 1 ? "it" : "them"} is refused:{" "}
                  {undeclared.join(", ")}
                </p>
              )}
              {t.variables.map((v, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <div className="min-w-40 flex-1">
                    <Label htmlFor={`var-name-${i}`}>Name</Label>
                    <Input
                      id={`var-name-${i}`}
                      value={v.name}
                      disabled={!canManage}
                      onChange={(e) =>
                        set(
                          "variables",
                          t.variables.map((x, j) =>
                            j === i ? { ...x, name: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </div>
                  <div className="min-w-40 flex-1">
                    <Label htmlFor={`var-default-${i}`}>Default</Label>
                    <Input
                      id={`var-default-${i}`}
                      value={v.default}
                      placeholder="none — the variable is required"
                      disabled={!canManage}
                      onChange={(e) =>
                        set(
                          "variables",
                          t.variables.map((x, j) =>
                            j === i ? { ...x, default: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canManage}
                    onClick={() =>
                      set(
                        "variables",
                        t.variables.filter((_, j) => j !== i),
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canManage}
                  onClick={() =>
                    set("variables", [
                      ...t.variables,
                      { name: "", default: "" },
                    ])
                  }
                >
                  Add variable
                </Button>
                {undeclared.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canManage}
                    onClick={() =>
                      set("variables", [
                        ...t.variables,
                        ...undeclared.map((n) => ({ name: n, default: "" })),
                      ])
                    }
                  >
                    Declare the {undeclared.length} missing
                  </Button>
                )}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              {preview.ok ? (
                <>
                  <p className="text-sm text-white/65">
                    {preview.data.subject}
                  </p>
                  {/* Same sandbox as the email detail view: no scripts, no
                      navigation. Escaping stops markup injection; the sandbox
                      is what stops a `javascript:` href in a variable. */}
                  <iframe
                    title="Template preview"
                    sandbox=""
                    srcDoc={preview.data.html}
                    className="h-96 w-full rounded-lg border border-white/10 bg-white"
                  />
                </>
              ) : (
                <p role="alert" className="text-sm text-red-300">
                  {preview.error}
                </p>
              )}
              <p className="text-xs text-white/50">
                Rendered by the same code the server uses. Variables with no
                default show as <code>{"{name}"}</code>.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>

      {mode === "edit" && versions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Version history</CardTitle>
          </CardHeader>
          <CardBody>
            <ul className="flex flex-col gap-2 text-sm">
              {versions.map((v, i) => (
                <li key={v.version} className="flex items-center gap-3">
                  <Badge variant={i === 0 ? "indigo" : "muted"}>
                    v{v.version}
                  </Badge>
                  <span className="text-white/65">{v.created}</span>
                  {i > 0 && canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => restore(v.version)}
                    >
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-white/50">
              Restoring appends a new version rather than rewinding, so the
              record of what was live and when stays complete.
            </p>
          </CardBody>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <Button disabled={!canManage || pending} onClick={save}>
          {pending ? "Saving…" : mode === "create" ? "Create" : "Save"}
        </Button>
        {saved && <span className="text-sm text-white/60">Saved.</span>}
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Write the two editor pages**

`apps/web/src/app/app/templates/new/page.tsx`:

```tsx
import { can } from "@sendsprite/shared";
import { requireTeam } from "@/lib/session";
import { TemplateEditor } from "../[slug]/TemplateEditor";

export const metadata = { title: "New template" };

export default async function NewTemplatePage() {
  const ctx = await requireTeam();
  return (
    <TemplateEditor
      mode="create"
      canManage={can(ctx.role, "templates.manage")}
    />
  );
}
```

`apps/web/src/app/app/templates/[slug]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { can } from "@sendsprite/shared";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { getTemplate, listTemplateVersions } from "@/services/templates";
import { TemplateEditor } from "./TemplateEditor";

export const metadata = { title: "Template" };

export default async function TemplatePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTeam();
  const t = await getTemplate(ctx.team.id, slug);
  if (!t) notFound();
  const versions = await listTemplateVersions(ctx.team.id, t.id);
  return (
    <TemplateEditor
      mode="edit"
      canManage={can(ctx.role, "templates.manage")}
      template={{
        slug: t.slug,
        name: t.name,
        subject: t.subject,
        bodyHtml: t.bodyHtml,
        bodyText: t.bodyText ?? "",
        variables: t.variablesSchema.variables.map((v) => ({
          name: v.name,
          default: v.default === undefined ? "" : String(v.default),
        })),
      }}
      versions={versions.map((v) => ({
        version: v.version,
        created: formatWhen(v.createdAt),
      }))}
    />
  );
}
```

- [ ] **Step 5: Check it in a browser**

Run: `bun run db:dev` in one terminal and `bun run dev` in another, then visit `/app/templates`, create a template with `{{name}}` in the subject and body, watch the preview update, save, edit, and restore version 1.

- [ ] **Step 6: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add apps/web/src/app/app/templates
git commit -m "feat(web): templates dashboard with a live preview and version history"
```

---

## Task 15: Dashboard — `/app/contacts`

Books, then contacts within a book: search, subscription status, add, unsubscribe, resubscribe, delete, CSV import and CSV export.

**Files:**

- Create: `apps/web/src/app/app/contacts/page.tsx`, `.../actions.ts`, `.../BooksPanel.tsx`, `.../[bookId]/page.tsx`, `.../[bookId]/ContactsPanel.tsx`, `.../[bookId]/export/route.ts`

- [ ] **Step 1: Write the server actions**

`apps/web/src/app/app/contacts/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { enqueue } from "@/jobs/enqueue";
import { requestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { requireTeam } from "@/lib/session";
import * as contacts from "@/services/contacts";
import type { ImportContactsResult } from "@sendsprite/shared";

export type { Result } from "@/lib/result";

async function actor() {
  const ctx = await requireTeam();
  return {
    userId: ctx.userId,
    teamId: ctx.team.id,
    teamName: ctx.team.name,
    role: ctx.role,
    meta: requestMeta(await headers()),
  };
}
const deps = { enqueue };

export async function createBook(fd: FormData): Promise<Result> {
  const res = await contacts.createBook(await actor(), {
    name: fd.get("name"),
    defaultFrom: String(fd.get("defaultFrom") ?? "").trim() || undefined,
  });
  if (!res.ok) return res;
  revalidatePath("/app/contacts");
  return { ok: true, data: undefined };
}

export async function deleteBook(bookId: string): Promise<Result> {
  const res = await contacts.deleteBook(await actor(), bookId);
  if (res.ok) revalidatePath("/app/contacts");
  return res;
}

export async function addContact(
  bookId: string,
  fd: FormData,
): Promise<Result> {
  const res = await contacts.createContact(
    await actor(),
    bookId,
    {
      email: fd.get("email"),
      firstName: String(fd.get("firstName") ?? "").trim() || undefined,
      lastName: String(fd.get("lastName") ?? "").trim() || undefined,
    },
    deps,
  );
  if (!res.ok) return res;
  revalidatePath(`/app/contacts/${bookId}`);
  return { ok: true, data: undefined };
}

export async function setSubscribed(
  bookId: string,
  contactId: string,
  subscribed: boolean,
): Promise<Result> {
  const res = await contacts.updateContact(
    await actor(),
    bookId,
    contactId,
    { subscribed, ...(subscribed ? {} : { unsubscribeReason: "manual" }) },
    deps,
  );
  if (!res.ok) return res;
  revalidatePath(`/app/contacts/${bookId}`);
  return { ok: true, data: undefined };
}

export async function removeContact(
  bookId: string,
  contactId: string,
): Promise<Result> {
  const res = await contacts.deleteContact(await actor(), bookId, contactId);
  if (res.ok) revalidatePath(`/app/contacts/${bookId}`);
  return res;
}

/** The client reads the file and sends its text; the service re-checks the cap. */
export async function importCsv(
  bookId: string,
  csv: string,
): Promise<Result<ImportContactsResult>> {
  const res = await contacts.importContacts(
    await actor(),
    bookId,
    { csv },
    deps,
  );
  if (res.ok) revalidatePath(`/app/contacts/${bookId}`);
  return res;
}
```

- [ ] **Step 2: Write the books page and panel**

`apps/web/src/app/app/contacts/page.tsx`:

```tsx
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { listBooks } from "@/services/contacts";
import { BooksPanel, type BookRow } from "./BooksPanel";

export const metadata = { title: "Contacts" };

export default async function ContactsPage() {
  const ctx = await requireTeam();
  const books: BookRow[] = (await listBooks(ctx.team.id)).map((b) => ({
    id: b.id,
    name: b.name,
    contactCount: b.contactCount,
    subscribedCount: b.subscribedCount,
    created: formatWhen(b.createdAt),
  }));
  return <BooksPanel books={books} role={ctx.role} />;
}
```

`apps/web/src/app/app/contacts/BooksPanel.tsx`:

```tsx
"use client";
import NextLink from "next/link";
import { useActionState, useState, useTransition } from "react";
import { can, type TeamRole } from "@sendsprite/shared";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { createBook, deleteBook, type Result } from "./actions";

export type BookRow = {
  id: string;
  name: string;
  contactCount: number;
  subscribedCount: number;
  created: string;
};

export function BooksPanel({
  books,
  role,
}: {
  books: BookRow[];
  role: TeamRole;
}) {
  const canManage = can(role, "contacts.manage");
  const canDelete = can(role, "settings.manage");
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => createBook(fd),
    null,
  );
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = (b: BookRow) => {
    if (
      !window.confirm(
        `Delete "${b.name}" and its ${b.contactCount} contacts? This cannot be undone.`,
      )
    )
      return;
    start(async () => {
      setError(null);
      const res: Result = await deleteBook(b.id);
      if (!res.ok) setError(res.error);
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>New contact book</CardTitle>
          </CardHeader>
          <CardBody>
            <form action={action} className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <Label htmlFor="book-name">Name</Label>
                <Input
                  id="book-name"
                  name="name"
                  placeholder="Newsletter"
                  required
                />
              </div>
              <div className="min-w-48 flex-1">
                <Label htmlFor="book-from">Default from (optional)</Label>
                <Input
                  id="book-from"
                  name="defaultFrom"
                  placeholder="Acme <hello@mail.acme.com>"
                />
              </div>
              <Button type="submit" disabled={pending}>
                {pending ? "Creating…" : "Create"}
              </Button>
            </form>
            {state && !state.ok && (
              <p role="alert" className="mt-3 text-sm text-red-300">
                {state.error}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {books.length === 0 ? (
        <EmptyState
          title="No contact books"
          body="A book is an audience. Contacts in it carry a subscription status — that is consent for campaigns, and it is separate from the suppression list, which blocks all mail to an address."
        />
      ) : (
        <div className="glass overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="num-stamp text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Book</th>
                <th className="px-4 py-3 font-medium">Contacts</th>
                <th className="px-4 py-3 font-medium">Subscribed</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {books.map((b) => (
                <tr key={b.id} className="border-t border-white/8">
                  <td className="px-4 py-3 font-medium">
                    <NextLink
                      href={`/app/contacts/${b.id}`}
                      className="underline decoration-white/30 underline-offset-2 hover:text-white"
                    >
                      {b.name}
                    </NextLink>
                  </td>
                  <td className="px-4 py-3 text-white/65">{b.contactCount}</td>
                  <td className="px-4 py-3 text-white/65">
                    {b.subscribedCount}
                  </td>
                  <td className="px-4 py-3 text-white/65">{b.created}</td>
                  <td className="px-4 py-3 text-right">
                    {canDelete && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => remove(b)}
                      >
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Write the contacts page and panel**

`apps/web/src/app/app/contacts/[bookId]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { getBook, listContactsPage } from "@/services/contacts";
import { ContactsPanel, type ContactRow } from "./ContactsPanel";

export const metadata = { title: "Contact book" };

/** One page of 100; the search box narrows rather than paging deeply. */
const PAGE = 100;

export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { bookId } = await params;
  const { q } = await searchParams;
  const ctx = await requireTeam();
  const book = await getBook(ctx.team.id, bookId);
  if (!book) notFound();
  const page = await listContactsPage(ctx.team.id, bookId, {
    limit: PAGE,
    ...(q ? { q } : {}),
  });
  const rows: ContactRow[] = page.ok
    ? page.data.data.map((c) => ({
        id: c.id,
        email: c.email,
        name: [c.firstName, c.lastName].filter(Boolean).join(" "),
        subscribed: c.subscribed,
        reason: c.unsubscribeReason,
        created: formatWhen(c.createdAt),
      }))
    : [];
  return (
    <ContactsPanel
      bookId={bookId}
      bookName={book.name}
      contacts={rows}
      query={q ?? ""}
      truncated={page.ok && page.data.nextCursor !== null}
      role={ctx.role}
    />
  );
}
```

`apps/web/src/app/app/contacts/[bookId]/ContactsPanel.tsx`:

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, useTransition } from "react";
import { can, type TeamRole } from "@sendsprite/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import {
  addContact,
  importCsv,
  removeContact,
  setSubscribed,
  type Result,
} from "../actions";

export type ContactRow = {
  id: string;
  email: string;
  name: string;
  subscribed: boolean;
  reason: string | null;
  created: string;
};

/** Matches `ImportContactsInput.csv`; refused here too so a 2 MB post is not made. */
const MAX_CSV_CHARS = 2 * 1024 * 1024;

export function ContactsPanel({
  bookId,
  bookName,
  contacts,
  query,
  truncated,
  role,
}: {
  bookId: string;
  bookName: string;
  contacts: ContactRow[];
  query: string;
  truncated: boolean;
  role: TeamRole;
}) {
  const router = useRouter();
  const canManage = can(role, "contacts.manage");
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => addContact(bookId, fd),
    null,
  );
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const act = (fn: () => Promise<Result>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error);
    });

  const onFile = async (file: File) => {
    setError(null);
    setImported(null);
    const text = await file.text();
    if (text.length > MAX_CSV_CHARS)
      return setError("That CSV is larger than 2 MB. Import it in chunks.");
    start(async () => {
      const res = await importCsv(bookId, text);
      if (!res.ok) return setError(res.error);
      const r = res.data;
      setImported(
        `${r.imported} added, ${r.updated} updated, ${r.skipped} skipped, ${r.duplicates} duplicate rows collapsed.` +
          (r.errors.length
            ? ` First problem: line ${r.errors[0]!.line} — ${r.errors[0]!.reason}`
            : ""),
      );
      if (fileRef.current) fileRef.current.value = "";
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="num-stamp">{bookName}</p>
        <a
          href={`/app/contacts/${bookId}/export`}
          className="text-sm text-white/60 underline decoration-white/30 underline-offset-2 hover:text-white"
        >
          Export CSV
        </a>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get("q");
          router.push(
            `/app/contacts/${bookId}${q ? `?q=${encodeURIComponent(String(q))}` : ""}`,
          );
        }}
      >
        <div className="min-w-64 flex-1">
          <Label htmlFor="contact-q">Search</Label>
          <Input
            id="contact-q"
            name="q"
            defaultValue={query}
            placeholder="address or name"
          />
        </div>
        <Button type="submit" variant="ghost">
          Search
        </Button>
      </form>

      {canManage && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Add a contact</CardTitle>
            </CardHeader>
            <CardBody>
              <form action={action} className="flex flex-wrap items-end gap-3">
                <div className="min-w-48 flex-1">
                  <Label htmlFor="c-email">Email</Label>
                  <Input id="c-email" name="email" type="email" required />
                </div>
                <div className="min-w-32 flex-1">
                  <Label htmlFor="c-first">First name</Label>
                  <Input id="c-first" name="firstName" />
                </div>
                <div className="min-w-32 flex-1">
                  <Label htmlFor="c-last">Last name</Label>
                  <Input id="c-last" name="lastName" />
                </div>
                <Button type="submit" disabled={pending}>
                  {pending ? "Adding…" : "Add"}
                </Button>
              </form>
              {state && !state.ok && (
                <p role="alert" className="mt-3 text-sm text-red-300">
                  {state.error}
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Import CSV</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                className="text-sm text-white/70"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
              <p className="text-xs text-white/50">
                Needs an <code>email</code> column; <code>first_name</code> and{" "}
                <code>last_name</code> are recognised and every other column
                becomes a property. Up to 2 MB and 10 000 rows per file.
              </p>
              {imported && <p className="text-sm text-white/70">{imported}</p>}
            </CardBody>
          </Card>
        </div>
      )}

      {contacts.length === 0 ? (
        <EmptyState
          title={query ? "No matches" : "No contacts yet"}
          body={
            query
              ? "Try a shorter search term."
              : "Add one above, or import a CSV."
          }
        />
      ) : (
        <div className="glass overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="num-stamp text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Added</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-t border-white/8">
                  <td className="px-4 py-3 font-medium">{c.email}</td>
                  <td className="px-4 py-3 text-white/65">{c.name || "—"}</td>
                  <td className="px-4 py-3">
                    <Badge variant={c.subscribed ? "success" : "warning"}>
                      {c.subscribed
                        ? "subscribed"
                        : (c.reason ?? "unsubscribed")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-white/65">{c.created}</td>
                  <td className="px-4 py-3 text-right">
                    {canManage && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            act(() =>
                              setSubscribed(bookId, c.id, !c.subscribed),
                            )
                          }
                        >
                          {c.subscribed ? "Unsubscribe" : "Resubscribe"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => act(() => removeContact(bookId, c.id))}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && (
        <p className="text-sm text-white/60">
          Showing the first 100. Use search to narrow, or export the whole book.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write the export route**

`apps/web/src/app/app/contacts/[bookId]/export/route.ts`:

```ts
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { contacts } from "@/db/schema";
import { toCsv } from "@/lib/csv";
import { requireTeam } from "@/lib/session";
import { getBook } from "@/services/contacts";

export const dynamic = "force-dynamic";

/**
 * The whole book as CSV. Session-authenticated (this lives under `/app`, not
 * `/api/v1`), so it is not part of the OpenAPI surface.
 *
 * Every cell goes through `toCsv` → `csvCell`, which prefixes a value starting
 * `=`, `+`, `-`, `@`, tab or CR with a `'`. A contact whose "first name" is
 * `=HYPERLINK(...)` must not become a live formula the moment somebody opens
 * the file in Excel.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ bookId: string }> },
): Promise<Response> {
  const { bookId } = await ctx.params;
  const team = await requireTeam();
  const book = await getBook(team.team.id, bookId);
  if (!book) return new Response("Not found", { status: 404 });

  const rows = await db()
    .select()
    .from(contacts)
    .where(eq(contacts.bookId, bookId))
    .orderBy(desc(contacts.createdAt));

  // Property keys vary per contact; the union of them, in first-seen order,
  // becomes the trailing columns.
  const propertyKeys: string[] = [];
  for (const r of rows)
    for (const k of Object.keys(r.properties))
      if (!propertyKeys.includes(k)) propertyKeys.push(k);

  const header = [
    "email",
    "first_name",
    "last_name",
    "subscribed",
    "unsubscribe_reason",
    "created_at",
    ...propertyKeys,
  ];
  const body = rows.map((r) => [
    r.email,
    r.firstName ?? "",
    r.lastName ?? "",
    String(r.subscribed),
    r.unsubscribeReason ?? "",
    r.createdAt.toISOString(),
    ...propertyKeys.map((k) => r.properties[k] ?? ""),
  ]);

  const slug =
    book.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "contacts";
  return new Response(toCsv(header, body), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${slug}.csv"`,
      "cache-control": "no-store, private",
    },
  });
}
```

- [ ] **Step 5: Check it in a browser**

With `bun run db:dev` and `bun run dev` running: create a book, add a contact, import this CSV and confirm the export escapes the formula.

```
email,first_name,plan
ada@example.com,=HYPERLINK("http://evil.test"),pro
grace@example.com,Grace,free
```

Expected: the import reports 2 added; the exported file's second column reads `"'=HYPERLINK(""http://evil.test"")"`.

- [ ] **Step 6: Run everything and commit**

Run: `bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add apps/web/src/app/app/contacts
git commit -m "feat(web): contacts dashboard with CSV import and safe export"
```

---

## Task 16: Docs, README, e2e, changeset and the status block

The last task closes the loop: two docs pages, the webhooks table that has been promising `contact.*` since Phase 3, the README's stale "templates ship in Phase 5" line, an e2e spec that drives the real server, and the status block a Phase 7 planner reads first.

**Files:**

- Create: `apps/web/src/app/docs/templates/page.mdx`, `apps/web/src/app/docs/contacts/page.mdx`, `apps/web/tests/e2e/templates.spec.ts`, `.changeset/phase-6-templates-contacts.md`
- Modify: `apps/web/src/app/docs/nav.ts`, `apps/web/src/app/docs/webhooks/page.mdx`, `README.md`, this plan file

- [ ] **Step 1: Write the e2e spec**

`apps/web/tests/e2e/templates.spec.ts`:

```ts
import { expect, test, type Page } from "@playwright/test";

// Runs after setup.spec.ts (project `app`), so the instance is set up. Each
// test starts from a fresh owner with their own team, so nothing leaks.

async function signUpOwner(page: Page, label: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await page.goto("/signup");
  await page.fill("#name", "Templates");
  await page.fill("#email", `${label}-${suffix}@example.com`);
  await page.fill("#password", "correct-horse-battery");
  await page.click("button[type=submit]");
  const createTeam = page.getByRole("button", { name: "Create team" });
  const checklist = page.getByText("Setup checklist");
  await expect(createTeam.or(checklist)).toBeVisible();
  if (await createTeam.isVisible()) {
    await page.fill("#name", `Templates ${suffix}`);
    await createTeam.click();
    await page.waitForURL("**/app");
  }
}

test("create a template, watch the preview escape a variable, then edit it", async ({
  page,
}) => {
  await signUpOwner(page, "templates");

  await page.goto("/app/templates");
  await page.getByRole("link", { name: "New template" }).first().click();
  await expect(page).toHaveURL(/\/app\/templates\/new$/);

  await page.fill("#tpl-name", "Welcome");
  await page.fill("#tpl-slug", "welcome");
  await page.fill("#tpl-subject", "Hi {{name}}");
  await page.fill("#tpl-html", "<p>Hello {{name}}</p>");

  // The variable is discovered from the body, and the editor warns that it is
  // not declared — an undeclared placeholder is a send that will be refused.
  await expect(
    page.getByRole("button", { name: "Insert {{name}}" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("name");

  // The preview renders through the *same* renderer the server uses, with the
  // stand-in value `{name}` for a variable that has no default.
  const preview = page.frameLocator('iframe[title="Template preview"]');
  await expect(preview.locator("p")).toHaveText("Hello {name}");

  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL("**/app/templates/welcome");

  // Reopening shows what was saved, at version 1.
  await expect(page.locator("#tpl-subject")).toHaveValue("Hi {{name}}");
  await expect(page.getByText("v1")).toBeVisible();

  // An edit bumps the version and appends to the history.
  await page.fill("#tpl-html", "<p>Hey {{name}}</p>");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("v2")).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();

  // And it is on the list.
  await page.goto("/app/templates");
  await expect(page.getByRole("cell", { name: "welcome" })).toBeVisible();
});

test("a contact book takes an import and exports it with formulas neutralised", async ({
  page,
}) => {
  await signUpOwner(page, "contacts");

  await page.goto("/app/contacts");
  await page.fill("#book-name", "Newsletter");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("link", { name: "Newsletter" }).click();
  await expect(page).toHaveURL(/\/app\/contacts\/cb_/);

  await page.setInputFiles('input[type="file"]', {
    name: "contacts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      'email,first_name,plan\nada@example.com,"=HYPERLINK(""http://evil.test"")",pro\ngrace@example.com,Grace,free\nbroken,X,y\n',
    ),
  });

  // Two good rows land; the third is reported and does not stop the import.
  await expect(page.getByText(/2 added/)).toBeVisible();
  await expect(page.getByText(/1 skipped/)).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "ada@example.com" }),
  ).toBeVisible();
  await expect(page.getByText("subscribed").first()).toBeVisible();

  // Unsubscribing is consent, and it shows as consent.
  await page
    .getByRole("row", { name: /grace@example.com/ })
    .getByRole("button", { name: "Unsubscribe" })
    .click();
  await expect(
    page.getByRole("row", { name: /grace@example.com/ }).getByText("manual"),
  ).toBeVisible();

  // The export escapes the formula rather than shipping a live one.
  const url = page.url().split("?")[0];
  const csv = await (await page.request.get(`${url}/export`)).text();
  expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
  expect(csv).not.toContain(`,=HYPERLINK`);
});
```

- [ ] **Step 2: Run the e2e spec**

Start a database first (**it is not optional**: without it the server dies in `runMigrations` with `ECONNREFUSED` before Playwright starts):

```bash
bun run db:dev          # one terminal, embedded Postgres on :5432
bun run test:e2e        # another
```

Expected: PASS, including every pre-existing spec.

- [ ] **Step 3: Write `/docs/templates`**

`apps/web/src/app/docs/templates/page.mdx`:

````mdx
export const metadata = {
  title: "Templates",
  description:
    "Sendsprite templates: the {{variable}} syntax, escaping rules, versioning, and sending with a template.",
};

# Templates

A template is a stored subject and body with `{{ variable }}` placeholders.
Send one by naming its **slug** instead of passing `html`:

```bash
curl https://mail.example.com/api/v1/emails \
  -H "Authorization: Bearer ss_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "from": "Acme <hello@mail.acme.com>",
    "to": ["ada@example.com"],
    "template": "welcome",
    "variables": { "name": "Ada" }
  }'
```

The render happens on the server, and the rendered subject and bodies are what
is stored and sent. `template` cannot be combined with `html` or `text` —
exactly one content source. `subject` is optional when a template supplies one,
and a request-level `subject` overrides the template's.

## The syntax

`{{ name }}`, and nothing else. Whitespace inside the braces is ignored, and
names may be dotted (`{{ user.firstName }}`) to reach into a nested object.

There are **no** helpers, filters, conditionals or loops, and there is **no
unescaped form** — no `{{{ }}}`, no `| safe`. A template engine's value is its
expression language, and its expression language is its attack surface; this
renders your customers' data into HTML that is then emailed, so there is
deliberately nothing to sandbox. For anything that needs logic, render it
yourself and pass `html` (the SDK's `react` option does exactly that).

Substituted text is never re-scanned, so a value containing `{{x}}` produces
the literal `{{x}}`.

## Escaping

Escaping is decided by the field, not by you:

| Field      | Rule                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `bodyHtml` | Every value is HTML-escaped (`&`, `<`, `>`, `"`, `'`).                                                                       |
| `bodyText` | No escaping — it is not markup.                                                                                              |
| `subject`  | No HTML escaping, but the **rendered** subject is rejected if it contains a line break, is empty, or exceeds 998 characters. |

The subject rule is the one that matters most: a CR/LF in a subject is header
injection, and the check on what you send cannot see what a template renders,
so it is repeated on the output.

Two things escaping does not do, and you should know both:

- It does not make a URL safe. `<a href="{{link}}">` with a `javascript:` value
  survives escaping. Validate URLs you interpolate.
- It does not sanitise the **template**. Whatever your team writes into
  `bodyHtml` is sent as written, exactly as `html` on `POST /emails` is.

## Variables

Every placeholder must resolve, or the send is refused with a
`validation_error` naming what is missing. A silent empty string produces
"Hi ," at volume and you find out from a customer.

Declare a variable with a `default` to make it genuinely optional:

```json
{
  "variablesSchema": {
    "variables": [
      {
        "name": "name",
        "type": "string",
        "required": false,
        "default": "there"
      }
    ]
  }
}
```

Values may be strings, numbers or booleans. `null`, `NaN`, objects and arrays
are refused rather than rendered.

## Versioning

Every content change bumps `version` and appends a snapshot. `GET
/api/v1/templates/:slug` returns the recent versions alongside the template,
and **Restore** in the dashboard applies an old snapshot as a _new_ version —
history is append-only, so what was live and when stays readable.

`slug` cannot be changed. A live send names a template by slug, so a rename
would be a silent outage; create the new one and delete the old.

## Previewing

`POST /api/v1/templates/:slug/render` with `{ "variables": { … } }` returns
`{ subject, html, text }` without sending or storing anything. It runs the same
renderer the send path runs, so the preview cannot differ from the send. The
dashboard editor calls the same function in your browser, which is why its
preview updates as you type.

## From the CLI

```bash
sendsprite templates pull ./emails    # <slug>.json / .html / .txt per template
sendsprite templates push ./emails    # create what is missing, update the rest
sendsprite templates push ./emails --dry-run
```
````

- [ ] **Step 4: Write `/docs/contacts`**

`apps/web/src/app/docs/contacts/page.mdx`:

````mdx
export const metadata = {
  title: "Contacts",
  description:
    "Sendsprite contact books, CSV import and export, subscription status, and why unsubscribing is not suppression.",
};

# Contacts

A **contact book** is an audience; a **contact** is one person in one book,
with a subscription status and any custom properties you attach.

```bash
curl https://mail.example.com/api/v1/contact-books \
  -H "Authorization: Bearer ss_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "name": "Newsletter" }'
# → 201 {"id":"cb_…", "contactCount":0, "subscribedCount":0}
```

## Unsubscribing is not suppression

These are two different things and Sendsprite keeps them apart on purpose:

|           | Suppression list                                     | Contact subscription                                      |
| --------- | ---------------------------------------------------- | --------------------------------------------------------- |
| Question  | "Can this address receive mail at all?"              | "Does this person want this kind of mail?"                |
| Scope     | The whole team                                       | One contact book                                          |
| Filled by | SES bounces and complaints, and `POST /suppressions` | `POST /contacts/unsubscribe`, the dashboard, CSV import   |
| Effect    | **Blocks every send**, transactional included        | Excludes the contact from campaigns. Blocks nothing else. |

Unsubscribing a contact never writes a suppression, and suppressing an address
never unsubscribes a contact. If it did, someone who left your newsletter would
stop receiving their password resets and their receipts. When you want mail to
an address to stop entirely, use the suppression list.

```bash
curl https://mail.example.com/api/v1/contacts/unsubscribe \
  -H "Authorization: Bearer ss_live_..." \
  -H "Content-Type: application/json" \
  -d '{ "email": "ada@example.com", "reason": "link" }'
# → 200 {"unsubscribed": 2}   (every book of the team; add "bookId" to narrow)
```

It is idempotent: an address that is already out returns `{"unsubscribed": 0}`.

## CSV import

`POST /api/v1/contact-books/:id/contacts/import` with `{ "csv": "…" }`, or the
**Import CSV** control in the dashboard.

The file needs an `email` column. `first_name` and `last_name` are recognised
(`firstName` / `first` too); **every other column becomes a property** on the
contact.

```csv
email,first_name,last_name,plan
ada@example.com,Ada,Lovelace,pro
grace@example.com,Grace,Hopper,free
```

```json
{ "imported": 2, "updated": 0, "skipped": 0, "duplicates": 0, "errors": [] }
```

Limits and behaviour:

- **2 MB and 10 000 rows per call.** Split a larger list; the endpoint is an
  upsert, so re-importing a chunk is safe.
- **A bad row does not fail the import.** It is counted in `skipped` and
  described in `errors` (up to 100 entries) with its line number. A structurally
  broken file — an unterminated quote — is refused whole, because nothing after
  it can be read reliably.
- **A duplicate address inside one file collapses to the last row**, counted in
  `duplicates`.
- `updateExisting: false` leaves addresses already in the book untouched.

## CSV export

**Export CSV** on a book downloads every contact, properties included.

Cells that a spreadsheet would evaluate as a formula — anything starting `=`,
`+`, `-`, `@`, a tab or a carriage return — are prefixed with an apostrophe, so
a contact whose "first name" is `=HYPERLINK(…)` opens as text rather than
running.

## Webhooks

Subscribe to `contact.created`, `contact.updated`, `contact.unsubscribed` and
`contact.resubscribed` to mirror consent into your own system. **CSV import
does not fire per-contact events** — ten thousand deliveries from one button
would take your endpoint down.
````

- [ ] **Step 5: Register the docs pages and un-reserve the webhook events**

In `apps/web/src/app/docs/nav.ts`, add after the `Sending` entry:

```ts
  { title: "Templates", href: "/docs/templates" },
  { title: "Contacts", href: "/docs/contacts" },
```

In `apps/web/src/app/docs/webhooks/page.mdx`, replace the two "reserved" rows of the events table:

```mdx
| `contact.created`, `contact.updated`, `contact.unsubscribed`, `contact.resubscribed` | A contact was added, changed, unsubscribed or resubscribed. CSV import does not fire these per row — see [Contacts](/docs/contacts). |
| `campaign.sent`, `campaign.completed` | Reserved for campaigns (Phase 7). |
```

- [ ] **Step 6: Update the README**

1. **The stale content line** (around line 211) — replace:

   > `template`/`variables` are accepted by the schema but templates ship in Phase 5.

   with:

   > `template` (+ `variables`) renders a stored template server-side and is
   > mutually exclusive with `html`/`text`; `subject` is optional when a
   > template supplies one. See [Templates](/docs/templates).

2. **Two new feature paragraphs**, next to the Suppressions section:

   > **Templates.** Store a subject and body with `{{ variable }}` placeholders,
   > version every change, and render them server-side at send time. Values are
   > HTML-escaped into the HTML body, left raw in the text body, and a rendered
   > subject carrying a line break is refused. There is no unescaped form and no
   > expression language — deliberately. `sendsprite templates pull|push <dir>`
   > keeps them in your repository.
   >
   > **Contacts.** Contact books, CSV import and export, search, and a
   > per-address unsubscribe. Subscription is **consent**, not deliverability:
   > it excludes a contact from campaigns and never blocks a transactional send.
   > The suppression list is what stops mail to an address entirely.

3. **Roadmap** — replace the last two sentences with:

   > Phase 5: billing — plans, usage metering, entitlements, `BILLING_ENABLED` —
   > done. Phase 6: templates and contacts — versioned templates with a
   > server-side render, contact books with CSV import/export and unsubscribe —
   > done. Phase 7 (next): campaigns and the block editor, preview, audit UI,
   > analytics.

- [ ] **Step 7: Add the changeset**

`.changeset/phase-6-templates-contacts.md`:

```md
---
"sendsprite": minor
"@sendsprite/mcp": minor
---

Templates and contacts: `templates`, `contactBooks` and `contacts` namespaces on the SDK, `templates pull|push <dir>` on the CLI, and `list_templates`, `render_template` and `add_contact` on the MCP server. `emails.send({ template, variables })` now renders server-side.
```

- [ ] **Step 8: Run the full gate**

```bash
bun run typecheck && bun run lint && bun run format:check && bun run test && bun run test:integration
# then, with `bun run db:dev` already running:
bun run test:e2e
```

Expected: all green. Record the counts for the status block.

- [ ] **Step 9: Append the status block to this plan, commit and tag**

Append a `## Phase 6 status: COMPLETE` section to this file in the shape Phase 5 used: what shipped per task with commit hashes, the gate counts, notes on anything that deviated from the plan and why, and a **Phase 7 openers** list seeded with:

1. **The block editor and campaigns are the whole of Phase 7.** `AppShell`'s `NAV` still links `/app/campaigns` at a page that does not exist — the last of the three placeholders Phase 1 left.
2. **Campaign recipient selection must skip suppressed contacts.** This is the one place consent and deliverability legitimately meet, and it is a read-time join at send time, not a write anywhere in Phase 6. Getting it wrong sends to an address SES already refused, which is a reputation cost.
3. **A public `/unsubscribe/:token` page and `List-Unsubscribe` headers.** Deferred deliberately: one-click unsubscribe (RFC 8058) needs `List-Unsubscribe-Post` on a send that knows which campaign it belongs to. `POST /contacts/unsubscribe` is the API a customer's own page calls in the meantime.
4. **No URL-scheme filter on interpolated values.** `<a href="{{link}}">` with a `javascript:` value survives HTML escaping. Every preview surface is `<iframe sandbox="">` and mail clients do not execute it, so the exposure is low — but a scheme allow-list for values that land inside an `href`/`src` attribute is a real hardening step.
5. **No inline variable autocomplete.** The editor offers insert-at-cursor chips and an undeclared-placeholder warning; true completion inside the body needs a code-editor component the UI kit does not have (and §10 says the kit is fixed).
6. **`variables_schema` types are declared but barely enforced.** `type` is checked against the supplied value at render time; `required` is not used at all (a missing value is always a refusal, with or without the flag), and `description` is not shown outside the editor. Either use them or drop them.
7. **CSV import is JSON-only.** `curl --data-binary @file.csv` with `content-type: text/csv` would be the natural shape for a shell user and is one branch in the import route.
8. **Import fires no webhook.** A summary `contacts.imported` event carrying the counts would let a customer mirror a bulk change without polling.
9. **The contacts dashboard shows the first 100 and stops.** Search narrows; there is no paging control, and no way to page a book of 50 000 in the UI. Export is the escape hatch.
10. **Template bodies are not deduplicated across versions.** Every version snapshot stores the whole body, so a 200 KB template edited 50 times is 10 MB. Bounded by hand-editing speed, but `template_versions` should eventually join the retention sweep.
11. **A template delete is not blocked by live sends.** Deleting a slug a scheduled email names makes that send fail at render time. A "used by N scheduled emails" check before deleting would be cheap.
12. **`emails.variables` is stored in full and purged with the body.** That is right for retention, but it means a send's variables outlive the body's retention window by exactly zero days — there is no separate, shorter window for what may be the most personal data in the row.

Then, and only then:

```bash
git add docs/superpowers/plans/2026-08-26-phase-6-templates-contacts.md apps/web README.md .changeset
git commit -m "docs: Phase 6 status and the Phase 7 openers"
git tag phase-6-complete
```

---

## Self-review

Run after writing the plan, before executing it.

**1. Spec coverage.** Every line of the brief maps to a task:

| Brief                                                 | Task                                 |
| ----------------------------------------------------- | ------------------------------------ |
| `templates` table, versioning, `{{variable}}` render  | 1, 2, 4, 6                           |
| Templating syntax + escaping decided and documented   | 1 (Decisions 1–2), 16                |
| `template` on send works; the Phase 5 refusal removed | 8                                    |
| REST templates (6 endpoints)                          | 9                                    |
| REST contact books + CSV import                       | 10                                   |
| REST contacts + `POST /contacts/unsubscribe`          | 10                                   |
| OpenAPI grows with the routes                         | 9, 10                                |
| Contacts: books, contacts, CSV, subscription status   | 3, 4, 5, 7, 10                       |
| Suppression vs unsubscribe kept apart                 | Decision 3, 7, 16                    |
| SDK namespaces + types parity + dist guard            | 11                                   |
| CLI `templates pull\|push <dir>`                      | 12                                   |
| MCP three tools                                       | 13                                   |
| Dashboard `/app/templates`                            | 14                                   |
| Dashboard `/app/contacts`                             | 15                                   |
| Audit rows for template and contact mutations         | 6, 7                                 |
| `sending_only` + `GET /emails` decided                | Decision 6 (left open, with reasons) |
| Migration tag + journal, `precision: 3` guard         | 4                                    |
| No self-enqueue on exclusive queues                   | Conventions (no queue is added)      |
| vitest from inside `apps/web`                         | Conventions, every Run line          |
| Pre-built e2e server                                  | Conventions, 16                      |
| CSV size/streaming/malformed/duplicates/injection     | Decision 4, 5, 7                     |

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no test described rather than written. The three places that say "reuse whatever that file names its helper" (Tasks 8, 11, 12, 13) name the shape they expect and are appending to a file the implementer has open; that is a read of existing code, not a gap.

**3. Type consistency.**

- `renderTemplate(template, variables, schema?)` — three positional arguments everywhere: Task 1 defines it, Task 6 (`renderStoredTemplate`), Task 8 (`createEmail`) and Task 14 (`TemplateEditor`) all call it that way.
- `TemplateSource` is `{ subject, bodyHtml, bodyText }`; every caller constructs exactly that from a `templates` row.
- `getTemplate(teamId, key)` in Task 6 is what Task 8 imports; `findTemplate` is never used as a name.
- `publicTemplate` / `publicTemplateVersion` / `publicContactBook` / `publicContact` are defined in Tasks 6–7 and used in Tasks 9–10.
- `ContactDeps` is `{ enqueue, now? }`; every contacts service function takes it, and every route passes `{ enqueue }`.
- `ImportContactsResult` fields (`imported`, `updated`, `skipped`, `duplicates`, `errors`) are identical in the shared contract (Task 3), the service (Task 7), the REST test (Task 10), the SDK type (Task 11) and the dashboard message (Task 15).
- `templates.remove(slug)` / `contactBooks.remove(id)` / `contacts.remove(bookId, id)` — `remove`, never `delete`, matching `Suppressions.remove`.
- `TemplateDetail` is added in Task 9 and consumed by the SDK in Task 11 and the parity tuple in Task 11 Step 6.
- The `allTrue` array is 35 entries before Task 11 and **55** after; the plan says so explicitly, and `tsc` enforces it.

**4. Ordering.** Nothing references a symbol from a later task: the renderer (1) precedes the contracts that import `placeholderNames` (2), which precede the schema that types `variables_schema` (4), which precedes the services (6, 7), which precede the send path (8) and the routes (9, 10), which precede the SDK (11), CLI (12), MCP (13) and the dashboard (14, 15). Task 5 (CSV) sits before Task 7, its only consumer.
