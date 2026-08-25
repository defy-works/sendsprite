# Phase 4 — Developer Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship everything a developer touches outside the dashboard: the `sendsprite` npm package (SDK + `sendsprite/react` + `sendsprite/next` + `npx sendsprite` CLI), `@sendsprite/mcp`, an OpenAPI 3.1 document rendered at `/docs/api`, a `/docs` MDX site, the landing page at `/`, and a publish pipeline — plus the Phase 4 openers left by the Phase 3 review.

**Architecture:** The REST v1 surface built in Phase 3 stays the single source of truth; everything in this phase is a client of it. Shared zod contracts (`@sendsprite/shared`) become complete for every REST resource so the OpenAPI document, the SDK types and the MCP tool schemas are all derived from the same objects. Published packages (`sendsprite`, `@sendsprite/mcp`) are built with tsup (ESM + CJS + `.d.ts`) and **inline** `@sendsprite/shared` (`noExternal`), so the shared package stays private and the web app keeps importing raw TS — no build-order coupling in the monorepo. The CLI ships inside the `sendsprite` package as its `bin` so `npx sendsprite` works. Docs and landing live in `apps/web` (MDX via `@next/mdx`, API reference via Scalar).

**Tech Stack:** Bun 1.3 workspaces, TypeScript 5.9, zod 4 (`z.toJSONSchema` for OpenAPI — no extra library), tsup 8.5, commander 15, `eventsource` 5 (Node SSE client), `@react-email/components` 1.0 / `@react-email/render` 2.1 (optional peers), `@modelcontextprotocol/sdk` 1.30, `@scalar/nextjs-api-reference` 0.11, `@next/mdx` 16.3, `@changesets/cli` 3.0, Vitest 4, Playwright.

**Read first (existing code the tasks build on):**

- `packages/shared/src/api/{errors,emails,webhooks}.ts` — `ERROR_CODES`, `HTTP_STATUS`, `SendEmailInput`, `EmailObject`, `EmailEventObject`, `ListQuery`, `signWebhook`, `verifyWebhookSignature`.
- `apps/web/src/lib/api-response.ts` — `fail`, `ok`, `noContent`, `readJson`, `tooLarge`, `rateHeaders`, `withApiKey(handler, { permission })`.
- `apps/web/src/lib/api-auth.ts` — `ApiAuthOk = { ok: true; team; key; ... }`, `keyActor`.
- `apps/web/src/app/api/v1/**/route.ts` — the fourteen REST routes (emails, emails/batch, emails/:id, emails/:id/cancel, domains, domains/:id, domains/:id/verify, api-keys, api-keys/:id, webhooks, webhooks/:id, webhooks/:id/test, suppressions, suppressions/:email).
- `apps/web/src/app/api/stream/route.ts` — session SSE (`event: change`, payload `{ type: "email" | "webhook", id }`).
- `apps/web/src/services/stats.ts` — `teamStats(teamId)` → `SendStats`.
- `apps/web/src/styles/globals.css` — `@theme` tokens and utilities `glass`, `hairline`, `outlined`, `grid-hairlines`, `num-stamp`, `rise-in`, `metric-xl`.

**Conventions carried over from Phases 1–3:**

- Commit messages: conventional (`feat(sdk): …`), no `Co-Authored-By`, no AI attribution.
- Every task ends green: `bun run typecheck && bun run lint && bun run format:check && bun run test` at the root, plus `bun run test:integration` when `apps/web` service or route code changed.
- Integration tests use embedded Postgres via `apps/web/tests/integration/setup` (see any existing `*.integration.test.ts`); no Docker on the dev machine.
- Tests for web live in `apps/web/tests/{unit,integration}`; for packages in `packages/<name>/tests`.
- Never self-enqueue from an exclusive pg-boss queue handler (not relevant here, but the rule stands).

**Deviation from the Phase 3 openers, decided here:** the opener "make `packages/shared` consumable (public, dual ESM/CJS build)" is satisfied differently — `@sendsprite/shared` stays `private` and is inlined into the published packages by tsup. Rationale: publishing a second package that the web app must build before `next dev`/`vitest` adds a build-order dependency to every workflow (dev, CI, Docker) for no consumer benefit; SDK users never import `@sendsprite/shared` directly. The `node:crypto`-free root barrel and the `/node` entry from the opener **are** done (Task 1) because `sendsprite`'s root entry must be bundler-safe.

**Deferred to Phase 5 (templates/contacts):** CLI `templates pull|push`; MCP tools `list_templates`, `render_template`, `add_contact`. The plan leaves the command/tool registries structured so these slot in.

---

## File structure

```
packages/shared/src/
  index.ts                      root barrel — no node:crypto imports (modified)
  node.ts                       NEW: `@sendsprite/shared/node` — signWebhook/verifyWebhookSignature
  api/webhooks.ts               types/constants only after the split (modified)
  api/webhook-signature.ts      NEW: the two crypto functions, moved verbatim
  api/domains.ts                NEW: CreateDomainInput, DomainObject, DnsRecordObject
  api/api-keys.ts               NEW: CreateApiKeyInput, ApiKeyObject, ApiKeyCreated
  api/webhook-objects.ts        NEW: CreateWebhookInput, UpdateWebhookInput, WebhookObject, WebhookCreated
  api/suppressions.ts           NEW: AddSuppressionInput, SuppressionObject
  api/emails.ts                 + PatchEmailInput, EmailEventObject.type enum, EmailDetail, PageQuery (modified)
  api/stats.ts                  NEW: SendStatsObject
  api/me.ts                     NEW: MeObject
  api/stream.ts                 NEW: StreamChange
  openapi.ts                    NEW: `buildOpenApiDocument()` — pure, zod → JSON Schema

apps/web/src/
  lib/sse.ts                    NEW: `teamChangeStream(teamId, signal)` extracted from api/stream/route.ts
  lib/api-response.ts           + `serviceFailure()` + `parsePage()` (modified)
  app/api/stream/route.ts       uses lib/sse.ts (modified)
  app/api/v1/stream/route.ts    NEW: API-key SSE
  app/api/v1/me/route.ts        NEW
  app/api/v1/stats/route.ts     NEW
  app/api/v1/openapi.json/route.ts  NEW (public)
  app/api/v1/{api-keys,domains,webhooks,suppressions}/route.ts  cursor pagination (modified)
  services/{api-keys,domains,webhooks,suppressions}.ts  keyset `list*` (modified)
  app/docs/layout.tsx           NEW: docs shell (sidebar nav)
  app/docs/page.mdx             NEW + one page.mdx per doc section
  app/docs/api/route.ts         NEW: Scalar reference
  app/page.tsx                  landing page (rewritten)
  components/landing/*.tsx      NEW: Hero, FeatureGrid, CodeTabs, Footer
  mdx-components.tsx            NEW (required by @next/mdx)
  next.config.ts                MDX + serverExternalPackages (modified)

packages/sdk/                   npm: `sendsprite`
  package.json, tsup.config.ts, tsconfig.json, README.md
  src/index.ts                  root entry: `Sendsprite`, errors, types
  src/client.ts                 HTTP core: auth, retry, error mapping
  src/errors.ts                 SendspriteError
  src/resources/{emails,domains,api-keys,webhooks,suppressions}.ts
  src/stream.ts                 SSE client (`client.stream()`), Node + browser fetch based
  src/react.tsx                 `sendsprite/react` entry
  src/next.ts                   `sendsprite/next` entry
  src/cli/index.ts              bin entry (commander)
  src/cli/config.ts             ~/.config/sendsprite/config.json
  src/cli/commands/{login,whoami,domains,emails}.ts
  tests/*.test.ts

packages/mcp/                   npm: `@sendsprite/mcp`
  package.json, tsup.config.ts, tsconfig.json, README.md
  src/server.ts                 `createServer(client)` — tool registry
  src/tools/{send-email,get-email-status,list-emails,search-emails,list-domains,get-send-stats}.ts
  src/index.ts                  bin: `--http [port]` → streamable HTTP, default stdio
  tests/*.test.ts

.changeset/config.json, .github/workflows/release.yml
Dockerfile (copy packages/*/package.json into deps layer)
```

---

## Task 1: Shared contracts for every REST resource + `node:crypto`-free root barrel

**Files:**

- Create: `packages/shared/src/api/webhook-signature.ts`, `packages/shared/src/node.ts`, `packages/shared/src/api/domains.ts`, `packages/shared/src/api/api-keys.ts`, `packages/shared/src/api/webhook-objects.ts`, `packages/shared/src/api/suppressions.ts`, `packages/shared/src/api/stats.ts`, `packages/shared/src/api/me.ts`, `packages/shared/src/api/stream.ts`
- Modify: `packages/shared/src/api/webhooks.ts`, `packages/shared/src/api/emails.ts`, `packages/shared/src/index.ts`, `packages/shared/package.json`, `packages/shared/tests/webhook-signature.test.ts`
- Modify (consumers of the moved functions): `apps/web/src/services/webhooks.ts` and any file `grep -rn "signWebhook\|verifyWebhookSignature" apps/web/src` reports — change the import to `@sendsprite/shared/node`.
- Modify (routes/services adopting the shared inputs): `apps/web/src/services/api-keys.ts` (`input` → `CreateApiKeyInput`), `apps/web/src/services/webhooks.ts` (`createInput`/`updateInput` → `CreateWebhookInput`/`UpdateWebhookInput`), `apps/web/src/app/api/v1/suppressions/route.ts` (`body` → `AddSuppressionInput`), `apps/web/src/app/api/v1/emails/[id]/route.ts` (PATCH body → `PatchEmailInput`).
- Test: `packages/shared/tests/api-objects.test.ts`, `packages/shared/tests/root-barrel.test.ts`

- [ ] **Step 1: Write the failing barrel test**

`packages/shared/tests/root-barrel.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as root from "../src/index";
import * as node from "../src/node";

describe("root barrel", () => {
  it("does not reference node:crypto anywhere in the root import graph", () => {
    // The root entry is inlined into the browser-safe `sendsprite` bundle.
    const files = [
      "src/index.ts",
      "src/ids.ts",
      "src/roles.ts",
      "src/api/errors.ts",
      "src/api/emails.ts",
      "src/api/webhooks.ts",
      "src/api/domains.ts",
      "src/api/api-keys.ts",
      "src/api/webhook-objects.ts",
      "src/api/suppressions.ts",
      "src/api/stats.ts",
      "src/api/me.ts",
      "src/api/stream.ts",
    ];
    for (const f of files) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/from "node:/);
    }
    expect("signWebhook" in root).toBe(false);
  });

  it("exposes the signing helpers from the node entry", () => {
    expect(typeof node.signWebhook).toBe("function");
    expect(typeof node.verifyWebhookSignature).toBe("function");
    expect(node.SIGNATURE_HEADER).toBe("sendsprite-signature");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/shared && bunx vitest run tests/root-barrel.test.ts`
Expected: FAIL — `../src/node` does not exist; `signWebhook in root` is `true`.

- [ ] **Step 3: Split the signature helpers out of `api/webhooks.ts`**

Move `signWebhook`, `verifyWebhookSignature` and their `node:crypto` import from `packages/shared/src/api/webhooks.ts` into a new `packages/shared/src/api/webhook-signature.ts`, unchanged, importing `SIGNATURE_TOLERANCE_SECONDS` from `./webhooks`. Delete the "browser bundles must not import this" header comment from `webhooks.ts` (it now holds only constants/types) and put it at the top of `webhook-signature.ts`.

Create `packages/shared/src/node.ts`:

```ts
/**
 * `@sendsprite/shared/node`: helpers that need `node:crypto`. The root
 * barrel stays free of Node built-ins so it can be inlined into browser-safe
 * bundles.
 */
export * from "./index";
export { signWebhook, verifyWebhookSignature } from "./api/webhook-signature";
```

`packages/shared/package.json` exports:

```json
"exports": {
  ".": "./src/index.ts",
  "./node": "./src/node.ts"
}
```

Update `packages/shared/tests/webhook-signature.test.ts` to import from `../src/node`. Update every `apps/web` import of `signWebhook`/`verifyWebhookSignature` to `@sendsprite/shared/node` (`grep -rn "signWebhook\|verifyWebhookSignature" apps/web/src apps/web/tests`).

- [ ] **Step 4: Write the failing contract test**

`packages/shared/tests/api-objects.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AddSuppressionInput,
  ApiKeyObject,
  CreateApiKeyInput,
  CreateDomainInput,
  CreateWebhookInput,
  DomainObject,
  EMAIL_EVENT_TYPES,
  EmailEventObject,
  PageQuery,
  PatchEmailInput,
  SendStatsObject,
  SuppressionObject,
  UpdateWebhookInput,
  WebhookObject,
} from "../src/index";

describe("shared REST contracts", () => {
  it("CreateDomainInput lowercases and rejects non-hostnames", () => {
    expect(CreateDomainInput.parse({ name: "Mail.Example.com" })).toEqual({
      name: "mail.example.com",
      dnsMode: "manual",
    });
    expect(CreateDomainInput.safeParse({ name: "not a host" }).success).toBe(
      false,
    );
    expect(
      CreateDomainInput.safeParse({ name: "a.io", dnsMode: "x" }).success,
    ).toBe(false);
  });

  it("CreateApiKeyInput defaults permission and drops empty domainId", () => {
    expect(CreateApiKeyInput.parse({ name: " k ", domainId: "" })).toEqual({
      name: "k",
      permission: "full",
      domainId: undefined,
    });
  });

  it("CreateWebhookInput requires https and at least one known event", () => {
    expect(
      CreateWebhookInput.safeParse({
        url: "http://x.io/h",
        events: ["email.sent"],
      }).success,
    ).toBe(false);
    expect(
      CreateWebhookInput.safeParse({ url: "https://x.io/h", events: ["nope"] })
        .success,
    ).toBe(false);
    expect(
      CreateWebhookInput.parse({
        url: "https://x.io/h",
        events: ["email.sent"],
      }),
    ).toEqual({ url: "https://x.io/h", events: ["email.sent"] });
    expect(UpdateWebhookInput.safeParse({}).success).toBe(false);
    expect(UpdateWebhookInput.parse({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it("AddSuppressionInput accepts manual/unsubscribe only", () => {
    expect(AddSuppressionInput.parse({ email: "A@b.io" })).toEqual({
      email: "a@b.io",
      reason: "manual",
    });
    expect(
      AddSuppressionInput.safeParse({ email: "a@b.io", reason: "bounce" })
        .success,
    ).toBe(false);
  });

  it("PatchEmailInput needs an ISO scheduledAt in the future-or-null form", () => {
    expect(PatchEmailInput.safeParse({ scheduledAt: "soon" }).success).toBe(
      false,
    );
    expect(
      PatchEmailInput.parse({ scheduledAt: "2030-01-01T00:00:00.000Z" }),
    ).toEqual({
      scheduledAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("PageQuery bounds limit and passes cursor through", () => {
    expect(PageQuery.parse({})).toEqual({ limit: 25 });
    expect(PageQuery.parse({ limit: "10", cursor: "c" })).toEqual({
      limit: 10,
      cursor: "c",
    });
    expect(PageQuery.safeParse({ limit: 500 }).success).toBe(false);
  });

  it("EmailEventObject.type is the closed event enum", () => {
    expect(EMAIL_EVENT_TYPES).toContain("delivered");
    expect(
      EmailEventObject.safeParse({
        id: "e",
        type: "nope",
        occurredAt: "x",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("output objects parse the public views", () => {
    expect(
      DomainObject.safeParse({
        id: "d",
        name: "a.io",
        status: "pending",
        dnsMode: "manual",
        region: "us-east-1",
        records: [
          {
            kind: "dkim",
            type: "CNAME",
            name: "n",
            value: "v",
            priority: null,
            ok: false,
          },
        ],
        lastError: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        verifiedAt: null,
      }).success,
    ).toBe(true);
    expect(
      ApiKeyObject.safeParse({
        id: "k",
        name: "n",
        permission: "full",
        keyPrefix: "ss_live_ab",
        domainId: null,
        lastUsedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      WebhookObject.safeParse({
        id: "w",
        url: "https://x.io",
        events: ["email.sent"],
        enabled: true,
        disabledReason: null,
        failingSince: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      SuppressionObject.safeParse({
        id: "s",
        email: "a@b.io",
        reason: "manual",
        note: null,
        sourceEmailId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      SendStatsObject.safeParse({
        sent: { today: 1, d7: 2, d30: 3 },
        rates: { delivered: 1, bounced: 0, complained: 0 },
        alerts: [],
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd packages/shared && bunx vitest run tests/api-objects.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 6: Add the contracts**

`packages/shared/src/api/domains.ts`:

```ts
import { z } from "zod";

/** RFC 1123 hostname, at least two labels. */
export const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const DNS_MODES = ["manual", "cloudflare"] as const;
export const DOMAIN_STATUS = [
  "pending",
  "provisioning",
  "verified",
  "failed",
] as const;
export const DNS_RECORD_KINDS = [
  "dkim",
  "mail_from_mx",
  "mail_from_spf",
  "dmarc",
] as const;

export const CreateDomainInput = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(HOSTNAME_RE, "Enter a valid domain name, e.g. mail.example.com."),
  dnsMode: z.enum(DNS_MODES).default("manual"),
});
export type CreateDomainInput = z.infer<typeof CreateDomainInput>;

export const DnsRecordObject = z.object({
  kind: z.string(),
  type: z.enum(["CNAME", "MX", "TXT"]),
  name: z.string(),
  value: z.string(),
  priority: z.number().int().nullable(),
  ok: z.boolean(),
});
export type DnsRecordObject = z.infer<typeof DnsRecordObject>;

export const DomainObject = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  dnsMode: z.enum(DNS_MODES),
  region: z.string(),
  records: z.array(DnsRecordObject),
  lastError: z.string().nullable(),
  createdAt: z.coerce.string(),
  verifiedAt: z.coerce.string().nullable(),
});
export type DomainObject = z.infer<typeof DomainObject>;
```

> Check `apps/web/src/services/domains.ts` for the actual `status` and `dnsMode` unions and the `expectedRecords[].kind` values; use `z.enum` with the exact set the service uses (the values above are the ones the plan author expects — verify, and keep `DomainObject.status` as the real enum). The existing `createDomain` input schema in `services/domains.ts` must be replaced by `CreateDomainInput` so both parse identically; keep any extra `cloudflare` precondition checks in the service.

`packages/shared/src/api/api-keys.ts`:

```ts
import { z } from "zod";

export const API_KEY_PERMISSIONS = ["full", "sending_only"] as const;

export const CreateApiKeyInput = z.object({
  name: z.string().trim().min(1, "Name is required.").max(64),
  permission: z.enum(API_KEY_PERMISSIONS).default("full"),
  // A form's empty <select> option arrives as ""; treat it as unset.
  domainId: z
    .string()
    .trim()
    .transform((s) => s || undefined)
    .optional(),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInput>;

export const ApiKeyObject = z.object({
  id: z.string(),
  name: z.string(),
  permission: z.enum(API_KEY_PERMISSIONS),
  keyPrefix: z.string(),
  domainId: z.string().nullable(),
  lastUsedAt: z.coerce.string().nullable(),
  createdAt: z.coerce.string(),
});
export type ApiKeyObject = z.infer<typeof ApiKeyObject>;

/** Returned once, by `POST /api-keys`. */
export const ApiKeyCreated = z.object({ id: z.string(), secret: z.string() });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;
```

`packages/shared/src/api/webhook-objects.ts` (copy the `url` and `events` validators from `apps/web/src/services/webhooks.ts` lines ~50–69 verbatim — https-only URL, non-empty subset of `WEBHOOK_EVENT_TYPES`, deduped):

```ts
import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "./webhooks";

const url = z
  .string()
  .trim()
  .url()
  .refine((u) => u.startsWith("https://"), "Webhook URLs must use https.");
const events = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .min(1, "Pick at least one event.")
  .transform((e) => [...new Set(e)]);

export const CreateWebhookInput = z.object({ url, events });
export type CreateWebhookInput = z.infer<typeof CreateWebhookInput>;

export const UpdateWebhookInput = z
  .object({ url, events, enabled: z.boolean() })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "Nothing to update.");
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookInput>;

export const WebhookObject = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
  enabled: z.boolean(),
  disabledReason: z.string().nullable(),
  failingSince: z.coerce.string().nullable(),
  createdAt: z.coerce.string(),
  updatedAt: z.coerce.string(),
});
export type WebhookObject = z.infer<typeof WebhookObject>;

/** Returned once, by `POST /webhooks`. */
export const WebhookCreated = z.object({ id: z.string(), secret: z.string() });
export type WebhookCreated = z.infer<typeof WebhookCreated>;

/** `POST /webhooks/:id/test` → 202. */
export const WebhookTestAccepted = z.object({ deliveryId: z.string() });
```

`packages/shared/src/api/suppressions.ts`:

```ts
import { z } from "zod";

export const SUPPRESSION_REASONS = [
  "bounce",
  "complaint",
  "manual",
  "unsubscribe",
] as const;

export const AddSuppressionInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  reason: z.enum(["manual", "unsubscribe"]).default("manual"),
  note: z.string().trim().max(500).optional(),
});
export type AddSuppressionInput = z.infer<typeof AddSuppressionInput>;

export const SuppressionObject = z.object({
  id: z.string(),
  email: z.string(),
  reason: z.enum(SUPPRESSION_REASONS),
  note: z.string().nullable(),
  sourceEmailId: z.string().nullable(),
  createdAt: z.coerce.string(),
});
export type SuppressionObject = z.infer<typeof SuppressionObject>;
```

`packages/shared/src/api/stats.ts`:

```ts
import { z } from "zod";

export const SendStatsObject = z.object({
  sent: z.object({ today: z.number(), d7: z.number(), d30: z.number() }),
  rates: z.object({
    delivered: z.number(),
    bounced: z.number(),
    complained: z.number(),
  }),
  alerts: z.array(
    z.object({
      kind: z.enum(["bounce", "complaint"]),
      level: z.enum(["warning", "critical"]),
      rate: z.number(),
      window: z.literal("24h"),
    }),
  ),
});
export type SendStatsObject = z.infer<typeof SendStatsObject>;
```

`packages/shared/src/api/me.ts`:

```ts
import { z } from "zod";
import { API_KEY_PERMISSIONS } from "./api-keys";

/** `GET /me`: what the bearer key can see about itself. */
export const MeObject = z.object({
  team: z.object({ id: z.string(), name: z.string() }),
  apiKey: z.object({
    id: z.string(),
    name: z.string(),
    permission: z.enum(API_KEY_PERMISSIONS),
    keyPrefix: z.string(),
    domainId: z.string().nullable(),
  }),
});
export type MeObject = z.infer<typeof MeObject>;
```

`packages/shared/src/api/stream.ts`:

```ts
import { z } from "zod";

/** One `event: change` message on `/api/v1/stream` (and the dashboard feed). */
export const StreamChange = z.object({
  type: z.enum(["email", "webhook"]),
  id: z.string().optional(),
});
export type StreamChange = z.infer<typeof StreamChange>;
```

Additions to `packages/shared/src/api/emails.ts`:

```ts
export const EMAIL_EVENT_TYPES = [
  "queued",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "opened",
  "clicked",
  "rejected",
  "failed",
  "cancelled",
  "rescheduled",
  "resent",
] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];
```

> Derive the real list from the `type` values `apps/web/src/services/email-events.ts` and `services/emails.ts` actually insert (`grep -rn "type: \"" apps/web/src/services/email-events.ts apps/web/src/services/emails.ts apps/web/src/services/tracking.ts`) — the enum must contain every value written to `email_events`, or `EmailEventObject.parse` on real rows fails. Then change `EmailEventObject.type` to `z.enum(EMAIL_EVENT_TYPES)`.

```ts
export const PatchEmailInput = z.object({
  scheduledAt: z.string().datetime({ offset: true }),
});
export type PatchEmailInput = z.infer<typeof PatchEmailInput>;

/** `GET /emails/:id`: the email plus its timeline, oldest first. */
export const EmailDetail = EmailObject.extend({
  events: z.array(EmailEventObject),
});
export type EmailDetail = z.infer<typeof EmailDetail>;

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

/** `{ data, nextCursor }` envelope of every list endpoint. */
export const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });
```

Rebuild `ListQuery` as `PageQuery.extend({ status, to, domainId, tag })` so the two agree.

`packages/shared/src/index.ts`:

```ts
export * from "./ids";
export * from "./roles";
export * from "./api/errors";
export * from "./api/emails";
export * from "./api/webhooks";
export * from "./api/webhook-objects";
export * from "./api/domains";
export * from "./api/api-keys";
export * from "./api/suppressions";
export * from "./api/stats";
export * from "./api/me";
export * from "./api/stream";
```

Then replace the local schemas in `apps/web/src/services/api-keys.ts`, `services/webhooks.ts`, `app/api/v1/suppressions/route.ts`, `app/api/v1/emails/[id]/route.ts` with the shared ones (delete the local copies; keep behaviour — run the existing integration tests to prove it).

- [ ] **Step 7: Run everything**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`
Expected: all green (unit 26 shared → more, web unit 98, integration 209).

- [ ] **Step 8: Commit**

```bash
git add packages/shared apps/web
git commit -m "feat(shared): REST contracts for every resource; node-only signing helpers move to @sendsprite/shared/node"
```

---

## Task 2: Cursor pagination on the remaining lists + `serviceFailure()` mapper

**Files:**

- Modify: `apps/web/src/lib/api-response.ts`, `apps/web/src/lib/result.ts`, `apps/web/src/services/{api-keys,domains,webhooks,suppressions}.ts`, `apps/web/src/app/api/v1/{api-keys,domains,webhooks,suppressions}/route.ts`, `apps/web/src/app/api/v1/{emails,domains}/_shared.ts`
- Test: `apps/web/tests/integration/rest-pagination.integration.test.ts`, `apps/web/tests/unit/service-failure.test.ts`

- [ ] **Step 1: Write the failing unit test for the mapper**

`apps/web/tests/unit/service-failure.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { serviceFailure } from "@/lib/api-response";

describe("serviceFailure", () => {
  it("maps a typed code to its HTTP status", async () => {
    const r = serviceFailure({ ok: false, error: "gone", code: "not_found" });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({
      error: { code: "not_found", message: "gone" },
    });
  });
  it("defaults to validation_error when the service gave no code", async () => {
    const r = serviceFailure({ ok: false, error: "bad" });
    expect(r.status).toBe(400);
  });
  it("treats an unknown upstream code (e.g. an AWS error name) as internal", async () => {
    const r = serviceFailure({ ok: false, error: "x", code: "Throttling" });
    expect(r.status).toBe(500);
    expect((await r.json()).error.code).toBe("internal_error");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project unit tests/unit/service-failure.test.ts`
Expected: FAIL — `serviceFailure` is not exported.

- [ ] **Step 3: Implement `serviceFailure` and `parsePage`**

In `apps/web/src/lib/result.ts` add:

```ts
import type { ErrorCode } from "@sendsprite/shared";
export const isErrorCode = (c: unknown): c is ErrorCode =>
  typeof c === "string" && (ERROR_CODES as readonly string[]).includes(c);
```

(import `ERROR_CODES` from `@sendsprite/shared`). In `apps/web/src/lib/api-response.ts` add:

```ts
import { PageQuery, type ErrorCode } from "@sendsprite/shared";
import { isErrorCode, type Result } from "./result";

/**
 * One mapping from a failed service `Result` to the error envelope: a known
 * `ErrorCode` keeps its status, an upstream code (AWS error names) is a
 * 500, and no code at all means the input was rejected (400).
 */
export function serviceFailure(
  r: Extract<Result<unknown>, { ok: false }>,
  headers?: HeadersInit,
) {
  if (r.code === undefined)
    return fail("validation_error", r.error, undefined, headers);
  if (isErrorCode(r.code)) return fail(r.code, r.error, undefined, headers);
  return fail("internal_error", r.error, undefined, headers);
}

/** `?limit=&cursor=` → `PageQuery`, or a 400 response. */
export function parsePage(req: Request) {
  const q = PageQuery.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  return q.success
    ? { ok: true as const, data: q.data }
    : {
        ok: false as const,
        res: fail(
          "validation_error",
          q.error.issues[0]?.message ?? "Invalid query.",
          q.error.issues,
        ),
      };
}
```

Replace the ad-hoc mappings in `apps/web/src/app/api/v1/emails/_shared.ts` (`sendFailure`) and `domains/_shared.ts` (`domainFailure`) with `serviceFailure` **where the service already returns an `ErrorCode`**; where a service returns a free-form `code` today, set the proper `ErrorCode` in the service instead (e.g. `not_found`, `conflict`, `domain_not_verified`, `suppressed_recipient`, `rate_limited`, `daily_quota_exceeded`, `monthly_quota_exceeded`, `sandbox_restricted`, `idempotency_conflict`). Keep the `_shared.ts` files only if they still do something beyond mapping (rate headers) — otherwise delete them.

- [ ] **Step 4: Write the failing integration test for pagination**

`apps/web/tests/integration/rest-pagination.integration.test.ts` — follow the setup used by the existing `rest-*.integration.test.ts` files (create a team, an API key with `full` permission, call the route handlers directly with a `Request`):

```ts
import { describe, expect, it } from "vitest";
import {
  GET as listKeys,
  POST as createKey,
} from "@/app/api/v1/api-keys/route";
import {
  GET as listSuppressions,
  POST as addSuppression,
} from "@/app/api/v1/suppressions/route";
import { seedTeamWithKey } from "./helpers"; // see existing rest tests for the helper name; create it if none exists

const get = (h: typeof listKeys, secret: string, qs = "") =>
  h(
    new Request(`http://x/api/v1/x${qs}`, {
      headers: { authorization: `Bearer ${secret}` },
    }),
    { params: Promise.resolve({}) },
  );

describe("cursor pagination", () => {
  it("api-keys: limit + nextCursor walk the whole set newest first, no repeats", async () => {
    const { secret } = await seedTeamWithKey();
    for (let i = 0; i < 5; i++)
      await createKey(
        new Request("http://x", {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: `k${i}` }),
        }),
        { params: Promise.resolve({}) },
      );
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await get(
        listKeys,
        secret,
        `?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.data.length).toBeLessThanOrEqual(2);
      seen.push(...body.data.map((k: { id: string }) => k.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(6); // 5 + the seeded key
  });

  it("suppressions: same envelope", async () => {
    const { secret } = await seedTeamWithKey();
    for (const e of ["a@x.io", "b@x.io", "c@x.io"])
      await addSuppression(
        new Request("http://x", {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: e }),
        }),
        { params: Promise.resolve({}) },
      );
    const r = await get(listSuppressions, secret, "?limit=2");
    const body = await r.json();
    expect(body.data).toHaveLength(2);
    expect(typeof body.nextCursor).toBe("string");
    const r2 = await get(
      listSuppressions,
      secret,
      `?limit=2&cursor=${body.nextCursor}`,
    );
    expect((await r2.json()).nextCursor).toBeNull();
  });

  it("rejects a bad limit", async () => {
    const { secret } = await seedTeamWithKey();
    expect((await get(listKeys, secret, "?limit=0")).status).toBe(400);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/rest-pagination.integration.test.ts`
Expected: FAIL — `nextCursor` undefined, limit ignored.

- [ ] **Step 6: Implement keyset paging in the four services and routes**

Follow the exact pattern of `listEmails` in `apps/web/src/services/emails.ts` (cursor = opaque `encodeCursor(createdAt, id)` from `src/lib/cursor.ts`, so a deleted anchor row still paginates and a garbage cursor is a 400; rows ordered by `(created_at desc, id desc)`; fetch `limit + 1`, return `{ data, nextCursor }`; the shared keyset body lives in `src/db/keyset.ts`). Add to each service a `listXPage(teamId, q: PageQuery)` next to the existing `listX(teamId)` (the dashboard keeps using the unpaged one):

```ts
export async function listApiKeysPage(
  teamId: string,
  q: PageQuery,
): Promise<{ data: ApiKey[]; nextCursor: string | null }> {
  const after = q.cursor
    ? await db()
        .select({ createdAt: apiKeys.createdAt, id: apiKeys.id })
        .from(apiKeys)
        .where(and(eq(apiKeys.teamId, teamId), eq(apiKeys.id, q.cursor)))
        .then((r) => r[0])
    : undefined;
  const rows = await db()
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.teamId, teamId),
        isNull(apiKeys.revokedAt),
        after
          ? or(
              lt(apiKeys.createdAt, after.createdAt),
              and(
                eq(apiKeys.createdAt, after.createdAt),
                lt(apiKeys.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
    .limit(q.limit + 1);
  const data = rows.slice(0, q.limit);
  return {
    data,
    nextCursor: rows.length > q.limit ? (data.at(-1)?.id ?? null) : null,
  };
}
```

Same shape for `listDomainsPage`, `listWebhooksPage`, `listSuppressionsPage`. Routes:

```ts
export const GET = withApiKey(
  async (req, auth) => {
    const q = parsePage(req);
    if (!q.ok) return q.res;
    const page = await listApiKeysPage(auth.team.id, q.data);
    return ok({
      data: page.data.map(publicApiKey),
      nextCursor: page.nextCursor,
    });
  },
  { permission: "full" },
);
```

Move the inline `view`/mapping lambdas in the api-keys and suppressions routes into the services as `publicApiKey` / `publicSuppression` (next to `publicDomain`, `publicWebhook`) so the OpenAPI task and the SDK types share one view per resource.

- [ ] **Step 7: Run all tests**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`
Expected: green; the existing dashboard list tests unaffected.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(api): cursor pagination on api-keys/domains/webhooks/suppressions; one serviceFailure mapper"
```

---

## Task 3: `/api/v1/me`, `/api/v1/stats`, and API-key SSE at `/api/v1/stream`

**Files:**

- Create: `apps/web/src/lib/sse.ts`, `apps/web/src/app/api/v1/me/route.ts`, `apps/web/src/app/api/v1/stats/route.ts`, `apps/web/src/app/api/v1/stream/route.ts`
- Modify: `apps/web/src/app/api/stream/route.ts`
- Test: `apps/web/tests/integration/rest-me-stats-stream.integration.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { GET as me } from "@/app/api/v1/me/route";
import { GET as stats } from "@/app/api/v1/stats/route";
import { GET as stream } from "@/app/api/v1/stream/route";
import { notifyTeam } from "@/lib/notify";
import { seedTeamWithKey } from "./helpers";

const auth = (secret: string) => ({
  headers: { authorization: `Bearer ${secret}` },
});
const ctx = { params: Promise.resolve({}) };

describe("GET /api/v1/me", () => {
  it("returns the team and the calling key", async () => {
    const { team, key, secret } = await seedTeamWithKey();
    const r = await me(new Request("http://x/api/v1/me", auth(secret)), ctx);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      team: { id: team.id, name: team.name },
      apiKey: {
        id: key.id,
        name: key.name,
        permission: "full",
        keyPrefix: key.keyPrefix,
        domainId: null,
      },
    });
  });
  it("works for a sending-only key too", async () => {
    const { secret } = await seedTeamWithKey({ permission: "sending_only" });
    expect(
      (await me(new Request("http://x/api/v1/me", auth(secret)), ctx)).status,
    ).toBe(200);
  });
});

describe("GET /api/v1/stats", () => {
  it("returns SendStats for a full key and 403 for sending-only", async () => {
    const { secret } = await seedTeamWithKey();
    const r = await stats(
      new Request("http://x/api/v1/stats", auth(secret)),
      ctx,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ sent: { today: 0 }, alerts: [] });
    const { secret: s2 } = await seedTeamWithKey({
      permission: "sending_only",
    });
    expect(
      (await stats(new Request("http://x/api/v1/stats", auth(s2)), ctx)).status,
    ).toBe(403);
  });
});

describe("GET /api/v1/stream", () => {
  it("streams change events for the key's team until aborted", async () => {
    const { team, secret } = await seedTeamWithKey();
    const ac = new AbortController();
    const r = await stream(
      new Request("http://x/api/v1/stream", {
        ...auth(secret),
        signal: ac.signal,
      }),
      ctx,
    );
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    // first chunk is ": connected"
    buf += dec.decode((await reader.read()).value);
    expect(buf).toContain(": connected");
    await notifyTeam(team.id, { type: "email", id: "em_1" });
    const deadline = Date.now() + 5_000;
    while (!buf.includes("event: change") && Date.now() < deadline)
      buf += dec.decode((await reader.read()).value);
    expect(buf).toContain('data: {"type":"email","id":"em_1"}');
    ac.abort();
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
  it("is 403 for sending-only keys", async () => {
    const { secret } = await seedTeamWithKey({ permission: "sending_only" });
    expect(
      (await stream(new Request("http://x/api/v1/stream", auth(secret)), ctx))
        .status,
    ).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && bunx vitest run --project integration tests/integration/rest-me-stats-stream.integration.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Extract `lib/sse.ts` and add the routes**

`apps/web/src/lib/sse.ts` — move the body of the session route's `GET` (everything after `requireTeam()`) into:

```ts
/** SSE response for a team's change feed; see api/stream/route.ts for the protocol. */
export function teamChangeStream(
  teamId: string,
  signal: AbortSignal,
): Response {
  /* the existing ReadableStream code, with `req.signal` → `signal` and `team.id` → `teamId` */
}
```

Session route becomes:

```ts
export async function GET(req: Request): Promise<Response> {
  const { team } = await requireTeam();
  return teamChangeStream(team.id, req.signal);
}
```

`apps/web/src/app/api/v1/stream/route.ts`:

```ts
import { teamChangeStream } from "@/lib/sse";
import { withApiKey } from "@/lib/api-response";
export const dynamic = "force-dynamic";
/** Same feed as the dashboard, for the CLI's `emails tail`. Full keys only. */
export const GET = withApiKey(
  async (req, auth) => teamChangeStream(auth.team.id, req.signal),
  { permission: "full" },
);
```

`me/route.ts`:

```ts
export const GET = withApiKey(async (_req, auth) =>
  ok({
    team: { id: auth.team.id, name: auth.team.name },
    apiKey: {
      id: auth.key.id,
      name: auth.key.name,
      permission: auth.key.permission,
      keyPrefix: auth.key.keyPrefix,
      domainId: auth.key.domainId,
    },
  } satisfies MeObject),
);
```

(Check `ApiAuthOk` in `lib/api-auth.ts` for the exact field names of the key/team; adjust.)

`stats/route.ts`: `withApiKey(async (_req, auth) => ok(await teamStats(auth.team.id)), { permission: "full" })`.

- [ ] **Step 4: Run tests, then the full suite**

Run: `bun run typecheck && bun run lint && bun run format && bun run test && bun run test:integration`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(api): /v1/me, /v1/stats and API-key SSE at /v1/stream"
```

---

## Task 4: OpenAPI 3.1 document from the shared contracts

**Files:**

- Create: `packages/shared/src/openapi.ts`, `apps/web/src/app/api/v1/openapi.json/route.ts`
- Test: `packages/shared/tests/openapi.test.ts`, `apps/web/tests/unit/openapi-coverage.test.ts`

- [ ] **Step 1: Write the failing shared test**

`packages/shared/tests/openapi.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi";

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument({ serverUrl: "https://mail.example.com" });

  it("is OpenAPI 3.1 with bearer auth and the instance as server", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers).toEqual([{ url: "https://mail.example.com/api/v1" }]);
    expect(doc.components.securitySchemes.apiKey).toEqual({
      type: "http",
      scheme: "bearer",
    });
    expect(doc.security).toEqual([{ apiKey: [] }]);
  });

  it("documents POST /emails with the SendEmailInput schema and both success codes", () => {
    const op = doc.paths["/emails"].post;
    expect(op.requestBody.content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/SendEmailInput",
    });
    expect(Object.keys(op.responses).sort()).toEqual([
      "200",
      "201",
      "400",
      "401",
      "403",
      "413",
      "422",
      "429",
    ]);
    expect(
      doc.components.schemas.SendEmailInput.properties.subject,
    ).toBeDefined();
  });

  it("every error response references the shared error envelope", () => {
    expect(
      doc.components.schemas.ApiError.properties.error.properties.code.enum,
    ).toContain("rate_limited");
  });

  it("list endpoints share the page envelope", () => {
    const schema =
      doc.paths["/domains"].get.responses["200"].content["application/json"]
        .schema;
    expect(schema.properties.nextCursor).toEqual({ type: ["string", "null"] });
  });

  it("is serialisable (no zod internals leak)", () => {
    expect(() => JSON.stringify(doc)).not.toThrow();
    expect(JSON.stringify(doc)).not.toMatch(/"~standard"|_zod/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && bunx vitest run tests/openapi.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the generator**

`packages/shared/src/openapi.ts` — zod 4's `z.toJSONSchema` with a shared registry so every schema becomes a `$ref`:

```ts
import { z } from "zod";
import { ERROR_CODES, HTTP_STATUS, type ErrorCode } from "./api/errors";
import {
  BatchSendInput,
  EmailDetail,
  EmailObject,
  ListQuery,
  PatchEmailInput,
  SendEmailInput,
  page,
} from "./api/emails";
import { CreateDomainInput, DomainObject } from "./api/domains";
import { ApiKeyCreated, ApiKeyObject, CreateApiKeyInput } from "./api/api-keys";
import {
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookCreated,
  WebhookObject,
  WebhookTestAccepted,
} from "./api/webhook-objects";
import { AddSuppressionInput, SuppressionObject } from "./api/suppressions";
import { SendStatsObject } from "./api/stats";
import { MeObject } from "./api/me";

const ApiError = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

const schemas = {
  ApiError,
  SendEmailInput,
  BatchSendInput,
  EmailObject,
  EmailDetail,
  PatchEmailInput,
  EmailPage: page(EmailObject),
  CreateDomainInput,
  DomainObject,
  DomainPage: page(DomainObject),
  CreateApiKeyInput,
  ApiKeyObject,
  ApiKeyCreated,
  ApiKeyPage: page(ApiKeyObject),
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookObject,
  WebhookCreated,
  WebhookTestAccepted,
  WebhookPage: page(WebhookObject),
  AddSuppressionInput,
  SuppressionObject,
  SuppressionPage: page(SuppressionObject),
  SendStatsObject,
  MeObject,
};

const ref = (name: keyof typeof schemas) => ({
  $ref: `#/components/schemas/${name}`,
});
const json = (schema: unknown, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const errors = (...codes: ErrorCode[]) =>
  Object.fromEntries(
    [...new Set(codes.map((c) => HTTP_STATUS[c]))].map((s) => [
      String(s),
      json(
        ref("ApiError"),
        codes.filter((c) => HTTP_STATUS[c] === s).join(" | "),
      ),
    ]),
  );
const common: ErrorCode[] = ["unauthorized", "forbidden"];
const pageParams = [
  {
    name: "limit",
    in: "query",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  },
  { name: "cursor", in: "query", schema: { type: "string" } },
];
const idParam = (name = "id") => ({
  name,
  in: "path",
  required: true,
  schema: { type: "string" },
});

export function buildOpenApiDocument(opts: {
  serverUrl: string;
  version?: string;
}) {
  const registry = z.registry<{ id: string }>();
  for (const [id, s] of Object.entries(schemas)) registry.add(s, { id });
  const gen = z.toJSONSchema(registry, {
    uri: (id) => `#/components/schemas/${id}`,
    unrepresentable: "any",
  });
  return {
    openapi: "3.1.0" as const,
    info: {
      title: "Sendsprite API",
      version: opts.version ?? "1.0.0",
      description: "Self-hosted email API on Amazon SES.",
    },
    servers: [{ url: `${opts.serverUrl.replace(/\/$/, "")}/api/v1` }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: { apiKey: { type: "http", scheme: "bearer" } },
      schemas: gen.schemas,
    },
    paths: {
      "/emails": {
        post: {
          operationId: "sendEmail",
          summary: "Send an email",
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("SendEmailInput") } },
          },
          responses: {
            "201": json(
              {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
              "Queued",
            ),
            "200": json(
              { type: "object", properties: { id: { type: "string" } } },
              "Idempotent replay",
            ),
            ...errors(
              ...common,
              "validation_error",
              "domain_not_verified",
              "suppressed_recipient",
              "sandbox_restricted",
              "rate_limited",
              "daily_quota_exceeded",
              "monthly_quota_exceeded",
              "payload_too_large",
            ),
          },
        },
        get: {
          operationId: "listEmails",
          summary: "List emails",
          parameters: [
            ...pageParams,
            ...["status", "to", "domainId", "tag"].map((n) => ({
              name: n,
              in: "query",
              schema: { type: "string" },
            })),
          ],
          responses: {
            "200": json(ref("EmailPage"), "Page"),
            ...errors(...common, "validation_error"),
          },
        },
      },
      "/emails/batch": {
        post: {
          operationId: "sendBatch",
          summary: "Send up to 100 emails",
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("BatchSendInput") } },
          },
          responses: {
            "201": json(
              {
                type: "object",
                properties: {
                  data: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: { id: { type: "string" } },
                    },
                  },
                },
              },
              "Queued",
            ),
            ...errors(
              ...common,
              "validation_error",
              "rate_limited",
              "payload_too_large",
            ),
          },
        },
      },
      "/emails/{id}": {
        get: {
          operationId: "getEmail",
          summary: "Get an email and its events",
          parameters: [idParam()],
          responses: {
            "200": json(ref("EmailDetail"), "Email"),
            ...errors(...common, "not_found"),
          },
        },
        patch: {
          operationId: "rescheduleEmail",
          summary: "Move a scheduled email",
          parameters: [idParam()],
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref("PatchEmailInput") } },
          },
          responses: {
            "200": json(ref("EmailObject"), "Email"),
            ...errors(...common, "validation_error", "not_found", "conflict"),
          },
        },
      },
      "/emails/{id}/cancel": {
        post: {
          operationId: "cancelEmail",
          summary: "Cancel a queued or scheduled email",
          parameters: [idParam()],
          responses: {
            "200": json(ref("EmailObject"), "Email"),
            ...errors(...common, "not_found", "conflict"),
          },
        },
      },
      "/domains": {
        get: {
          operationId: "listDomains",
          parameters: pageParams,
          responses: {
            "200": json(ref("DomainPage"), "Page"),
            ...errors(...common),
          },
        },
        post: {
          operationId: "createDomain",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: ref("CreateDomainInput") },
            },
          },
          responses: {
            "201": json(ref("DomainObject"), "Domain"),
            ...errors(...common, "validation_error", "conflict"),
          },
        },
      },
      "/domains/{id}": {
        get: {
          operationId: "getDomain",
          parameters: [idParam()],
          responses: {
            "200": json(ref("DomainObject"), "Domain"),
            ...errors(...common, "not_found"),
          },
        },
        delete: {
          operationId: "deleteDomain",
          parameters: [idParam()],
          responses: {
            "204": { description: "Deleted" },
            "200": json(
              {
                type: "object",
                properties: {
                  leftoverDnsRecords: { type: "integer" },
                },
              },
              "Deleted; some DNS records need manual cleanup",
            ),
            ...errors(...common, "not_found"),
          },
        },
      },
      "/domains/{id}/verify": {
        post: {
          operationId: "verifyDomain",
          parameters: [idParam()],
          responses: {
            "200": json(ref("DomainObject"), "Domain"),
            ...errors(...common, "not_found"),
          },
        },
      },
      "/api-keys": {
        get: {
          operationId: "listApiKeys",
          parameters: pageParams,
          responses: {
            "200": json(ref("ApiKeyPage"), "Page"),
            ...errors(...common),
          },
        },
        post: {
          operationId: "createApiKey",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: ref("CreateApiKeyInput") },
            },
          },
          responses: {
            "201": json(
              ref("ApiKeyCreated"),
              "Created — the secret is shown once",
            ),
            ...errors(...common, "validation_error"),
          },
        },
      },
      "/api-keys/{id}": {
        delete: {
          operationId: "revokeApiKey",
          parameters: [idParam()],
          responses: {
            "204": { description: "Revoked" },
            ...errors(...common, "not_found"),
          },
        },
      },
      "/webhooks": {
        get: {
          operationId: "listWebhooks",
          parameters: pageParams,
          responses: {
            "200": json(ref("WebhookPage"), "Page"),
            ...errors(...common),
          },
        },
        post: {
          operationId: "createWebhook",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: ref("CreateWebhookInput") },
            },
          },
          responses: {
            "201": json(
              ref("WebhookCreated"),
              "Created — the secret is shown once",
            ),
            ...errors(...common, "validation_error"),
          },
        },
      },
      "/webhooks/{id}": {
        patch: {
          operationId: "updateWebhook",
          parameters: [idParam()],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: ref("UpdateWebhookInput") },
            },
          },
          responses: {
            "200": json(ref("WebhookObject"), "Webhook"),
            ...errors(...common, "validation_error", "not_found"),
          },
        },
        delete: {
          operationId: "deleteWebhook",
          parameters: [idParam()],
          responses: {
            "204": { description: "Deleted" },
            ...errors(...common, "not_found"),
          },
        },
      },
      "/webhooks/{id}/test": {
        post: {
          operationId: "testWebhook",
          parameters: [idParam()],
          responses: {
            "202": json(ref("WebhookTestAccepted"), "Delivery queued"),
            ...errors(...common, "not_found"),
          },
        },
      },
      "/suppressions": {
        get: {
          operationId: "listSuppressions",
          parameters: pageParams,
          responses: {
            "200": json(ref("SuppressionPage"), "Page"),
            ...errors(...common),
          },
        },
        post: {
          operationId: "addSuppression",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: ref("AddSuppressionInput") },
            },
          },
          responses: {
            "201": json(ref("SuppressionObject"), "Suppression"),
            ...errors(...common, "validation_error"),
          },
        },
      },
      "/suppressions/{email}": {
        delete: {
          operationId: "removeSuppression",
          parameters: [idParam("email")],
          responses: {
            "204": { description: "Removed" },
            ...errors(...common, "not_found"),
          },
        },
      },
      "/stats": {
        get: {
          operationId: "getSendStats",
          responses: {
            "200": json(ref("SendStatsObject"), "Stats"),
            ...errors(...common),
          },
        },
      },
      "/me": {
        get: {
          operationId: "getMe",
          responses: {
            "200": json(ref("MeObject"), "Caller"),
            ...errors("unauthorized"),
          },
        },
      },
      "/stream": {
        get: {
          operationId: "streamChanges",
          summary: "Server-sent events: `event: change`, data `{ type, id }`",
          responses: {
            "200": {
              description: "text/event-stream",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            ...errors(...common),
          },
        },
      },
    },
  };
}
export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
```

> `z.toJSONSchema(registry, …)` returns `{ schemas: Record<id, JSONSchema> }` in zod 4 — confirm the exact option names against the installed `zod` (`node_modules/zod/v4/core/to-json-schema.d.ts`). If registry output nests `$defs`, flatten so `components.schemas.<Id>` holds each schema and internal refs point at `#/components/schemas/<Id>`. Match the actual status codes each route returns (e.g. `conflict` on `POST /domains` only if `createDomain` returns it) — read each route and make the document truthful; the coverage test below only checks paths/methods, so status-code truth is on the implementer.

- [ ] **Step 4: Write the failing coverage test in the web app**

`apps/web/tests/unit/openapi-coverage.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@sendsprite/shared/openapi";

const root = join(process.cwd(), "src/app/api/v1");
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) =>
    statSync(join(d, n)).isDirectory()
      ? walk(join(d, n))
      : n === "route.ts"
        ? [join(d, n)]
        : [],
  );

describe("OpenAPI covers every REST route", () => {
  const doc = buildOpenApiDocument({ serverUrl: "http://x" });
  for (const file of walk(root)) {
    const path =
      "/" +
      relative(root, file)
        .replace(/\\/g, "/")
        .replace(/\/route\.ts$/, "")
        .replace(/\[(\w+)\]/g, "{$1}");
    if (path === "/openapi.json") continue;
    const src = readFileSync(file, "utf8");
    const methods = [
      ...src.matchAll(/^export const (GET|POST|PATCH|PUT|DELETE)\b/gm),
    ].map((m) => m[1]!.toLowerCase());
    it(`${path} → ${methods.join(",")}`, () => {
      const entry = (doc.paths as Record<string, Record<string, unknown>>)[
        path
      ];
      expect(entry, `path ${path} missing from OpenAPI`).toBeDefined();
      for (const m of methods)
        expect(entry![m], `${m.toUpperCase()} ${path}`).toBeDefined();
    });
  }
});
```

Add `"./openapi": "./src/openapi.ts"` to `packages/shared/package.json` exports (so the web app can import it without pulling it into the SDK bundle).

- [ ] **Step 5: Add the public route**

`apps/web/src/app/api/v1/openapi.json/route.ts`:

```ts
import { buildOpenApiDocument } from "@sendsprite/shared/openapi";
import { env } from "@/env";
export const dynamic = "force-dynamic";
/** Public: the document contains no instance data beyond the base URL. */
export async function GET() {
  return Response.json(
    buildOpenApiDocument({
      serverUrl: env.APP_URL,
      version: process.env.APP_VERSION ?? "dev",
    }),
    {
      headers: { "cache-control": "public, max-age=300" },
    },
  );
}
```

(Use whichever env key holds the public base URL — `grep -n "APP_URL\|BASE_URL" apps/web/src/env.schema.ts`.)

- [ ] **Step 6: Run tests**

Run: `bun run typecheck && bun run lint && bun run format && bun run test`
Expected: green; the coverage test lists 17 paths.

- [ ] **Step 7: Commit**

```bash
git add packages/shared apps/web
git commit -m "feat(api): OpenAPI 3.1 document generated from the shared zod contracts at /api/v1/openapi.json"
```

---

## Task 5: `sendsprite` package scaffold + HTTP core with retry and typed errors

**Files:**

- Create: `packages/sdk/package.json`, `packages/sdk/tsconfig.json`, `packages/sdk/tsup.config.ts`, `packages/sdk/src/errors.ts`, `packages/sdk/src/client.ts`, `packages/sdk/src/index.ts`, `packages/sdk/README.md`
- Modify: `eslint.config.js` (nothing needed — `dist/` already ignored), root `package.json` (`build` already filters `*`)
- Test: `packages/sdk/tests/client.test.ts`

- [ ] **Step 1: Scaffold**

`packages/sdk/package.json`:

```json
{
  "name": "sendsprite",
  "version": "0.1.0",
  "description": "TypeScript SDK, React email helpers, Next.js webhook handler and CLI for Sendsprite.",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/defy-works/sendsprite",
    "directory": "packages/sdk"
  },
  "type": "module",
  "sideEffects": false,
  "files": ["dist", "README.md"],
  "bin": { "sendsprite": "./dist/cli.js" },
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs"
      }
    },
    "./react": {
      "import": { "types": "./dist/react.d.ts", "default": "./dist/react.js" },
      "require": {
        "types": "./dist/react.d.cts",
        "default": "./dist/react.cjs"
      }
    },
    "./next": {
      "import": { "types": "./dist/next.d.ts", "default": "./dist/next.js" },
      "require": { "types": "./dist/next.d.cts", "default": "./dist/next.cjs" }
    }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "prepublishOnly": "bun run build"
  },
  "dependencies": { "commander": "^15.0.0", "eventsource": "^5.1.1" },
  "devDependencies": {
    "@sendsprite/shared": "workspace:*",
    "@react-email/components": "^1.0.12",
    "@react-email/render": "^2.1.0",
    "@types/react": "^19.2.18",
    "react": "^19.2.8",
    "tsup": "^8.5.1",
    "vitest": "^4.1.0",
    "bun-types": "^1.2.0"
  },
  "peerDependencies": {
    "@react-email/components": ">=0.0.30",
    "@react-email/render": ">=1.0.0",
    "react": "^18 || ^19"
  },
  "peerDependenciesMeta": {
    "@react-email/components": { "optional": true },
    "@react-email/render": { "optional": true },
    "react": { "optional": true }
  },
  "engines": { "node": ">=20" }
}
```

`packages/sdk/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "jsx": "react-jsx", "types": ["bun-types", "node"] }, "include": ["src", "tests"] }` (add `@types/node` to devDependencies).

`packages/sdk/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";
export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      react: "src/react.tsx",
      next: "src/next.ts",
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    noExternal: ["@sendsprite/shared"],
    external: ["react", "@react-email/render", "@react-email/components"],
  },
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    banner: { js: "#!/usr/bin/env node" },
    target: "node20",
    noExternal: ["@sendsprite/shared"],
  },
]);
```

Vitest config `packages/sdk/vitest.config.ts`: `export default defineConfig({ test: { include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"] } })`.

- [ ] **Step 2: Write the failing core test**

`packages/sdk/tests/client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sendsprite, SendspriteError } from "../src/index";

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const mock = (...responses: Response[]) => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const r of responses) fetch.mockResolvedValueOnce(r);
  return fetch;
};

afterEach(() => vi.useRealTimers());

describe("Sendsprite client core", () => {
  it("sends the bearer key, JSON body and user-agent to <baseUrl>/api/v1", async () => {
    const fetch = mock(json(201, { id: "em_1" }));
    const c = new Sendsprite({
      apiKey: "ss_live_x",
      baseUrl: "https://mail.acme.com/",
      fetch,
    });
    const r = await c.request<{ id: string }>("POST", "/emails", {
      body: { from: "a@b.io" },
    });
    expect(r).toEqual({ id: "em_1" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://mail.acme.com/api/v1/emails");
    expect(init!.method).toBe("POST");
    expect(new Headers(init!.headers).get("authorization")).toBe(
      "Bearer ss_live_x",
    );
    expect(new Headers(init!.headers).get("user-agent")).toMatch(
      /^sendsprite-node\//,
    );
    expect(init!.body).toBe(JSON.stringify({ from: "a@b.io" }));
  });

  it("throws SendspriteError carrying code, status, message, details and requestId", async () => {
    const fetch = mock(
      json(
        422,
        {
          error: {
            code: "domain_not_verified",
            message: "Verify first.",
            details: { domain: "b.io" },
          },
        },
        { "x-request-id": "req_1" },
      ),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const err = await c.request("POST", "/emails", {}).catch((e) => e);
    expect(err).toBeInstanceOf(SendspriteError);
    expect(err).toMatchObject({
      code: "domain_not_verified",
      status: 422,
      message: "Verify first.",
      details: { domain: "b.io" },
      requestId: "req_1",
    });
  });

  it("retries 429 and 5xx with backoff, honouring retry-after, then succeeds", async () => {
    vi.useFakeTimers();
    const fetch = mock(
      json(
        429,
        { error: { code: "rate_limited", message: "slow" } },
        { "retry-after": "2" },
      ),
      json(503, { error: { code: "internal_error", message: "x" } }),
      json(200, { ok: true }),
    );
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 3,
    });
    const p = c.request("GET", "/me");
    await vi.advanceTimersByTimeAsync(2_000); // retry-after
    await vi.advanceTimersByTimeAsync(1_000); // 2nd backoff (500ms * 2^1 = 1s ± jitter)
    await expect(p).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx other than 429, and gives up after maxRetries", async () => {
    const fetch = mock(
      json(400, { error: { code: "validation_error", message: "bad" } }),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await expect(c.request("POST", "/emails", {})).rejects.toMatchObject({
      code: "validation_error",
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    const f2 = mock(
      json(500, { error: { code: "internal_error", message: "x" } }),
      json(500, { error: { code: "internal_error", message: "x" } }),
    );
    const c2 = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch: f2,
      maxRetries: 1,
    });
    const p = c2.request("GET", "/me").catch((e) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toMatchObject({ code: "internal_error", status: 500 });
    expect(f2).toHaveBeenCalledTimes(2);
  });

  it("never retries a POST /emails that has no idempotencyKey", async () => {
    vi.useFakeTimers();
    const fetch = mock(
      json(503, { error: { code: "internal_error", message: "x" } }),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const p = c
      .request("POST", "/emails", { body: { subject: "s" }, retry: false })
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("wraps network failures and non-JSON bodies", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("fetch failed"));
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 0,
    });
    await expect(c.request("GET", "/me")).rejects.toMatchObject({
      code: "network_error",
    });
    const f2 = mock(new Response("<html>502</html>", { status: 502 }));
    const c2 = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch: f2,
      maxRetries: 0,
    });
    await expect(c2.request("GET", "/me")).rejects.toMatchObject({
      code: "internal_error",
      status: 502,
    });
  });

  it("reads SENDSPRITE_API_KEY / SENDSPRITE_URL when options are omitted", () => {
    process.env.SENDSPRITE_API_KEY = "ss_live_env";
    process.env.SENDSPRITE_URL = "https://env.example";
    const c = new Sendsprite();
    expect(c.baseUrl).toBe("https://env.example");
    delete process.env.SENDSPRITE_API_KEY;
    delete process.env.SENDSPRITE_URL;
    expect(() => new Sendsprite()).toThrow(/apiKey/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/sdk && bun install && bunx vitest run tests/client.test.ts`
Expected: FAIL — `../src/index` missing.

- [ ] **Step 4: Implement**

`packages/sdk/src/errors.ts`:

```ts
import type { ErrorCode } from "@sendsprite/shared";

export type SendspriteErrorCode = ErrorCode | "network_error";

export class SendspriteError extends Error {
  readonly name = "SendspriteError";
  constructor(
    readonly code: SendspriteErrorCode,
    message: string,
    readonly status: number | null,
    readonly details?: unknown,
    readonly requestId?: string | null,
  ) {
    super(message);
  }
  /** True for 429 and 5xx: the request may be retried as-is. */
  get retryable() {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}
```

`packages/sdk/src/client.ts`:

```ts
import { SendspriteError } from "./errors";

export const SDK_VERSION = "0.1.0"; // bumped by changesets via scripts/sync-version.ts (Task 12)

export interface SendspriteOptions {
  /** `ss_live_…` key; defaults to `SENDSPRITE_API_KEY`. */
  apiKey?: string;
  /** Your instance, e.g. `https://mail.acme.com`; defaults to `SENDSPRITE_URL`. */
  baseUrl?: string;
  /** Retries on 429/5xx/network errors (default 2). */
  maxRetries?: number;
  /** Per-request timeout in ms (default 30 000). */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Set false for non-idempotent calls (a send without an idempotency key). */
  retry?: boolean;
  signal?: AbortSignal;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

export class HttpClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(o: SendspriteOptions = {}) {
    const apiKey = o.apiKey ?? readEnv("SENDSPRITE_API_KEY");
    const baseUrl = o.baseUrl ?? readEnv("SENDSPRITE_URL");
    if (!apiKey)
      throw new Error(
        "Sendsprite: apiKey is required (or set SENDSPRITE_API_KEY).",
      );
    if (!baseUrl)
      throw new Error(
        "Sendsprite: baseUrl is required (or set SENDSPRITE_URL).",
      );
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.maxRetries = o.maxRetries ?? 2;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.fetchImpl = o.fetch ?? globalThis.fetch;
  }

  async request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const retry = opts.retry ?? method !== "POST";
    let attempt = 0;
    for (;;) {
      const res = await this.once(method, url, opts).catch((e: unknown) => e);
      const err =
        res instanceof Response
          ? await toError(res)
          : new SendspriteError(
              "network_error",
              String(((e) => (e instanceof Error ? e.message : e))(res)),
              null,
            );
      if (res instanceof Response && !err)
        return res.status === 204
          ? (undefined as T)
          : ((await res.json()) as T);
      if (!retry || !err!.retryable || attempt >= this.maxRetries) throw err;
      const ra =
        res instanceof Response ? Number(res.headers.get("retry-after")) : NaN;
      const delay =
        Number.isFinite(ra) && ra > 0
          ? ra * 1000
          : Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) *
            (0.8 + Math.random() * 0.4);
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }

  private once(method: string, url: URL, opts: RequestOptions) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(new Error("timeout")), this.timeoutMs);
    opts.signal?.addEventListener(
      "abort",
      () => ac.abort(opts.signal!.reason),
      { once: true },
    );
    return this.fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "user-agent": `sendsprite-node/${SDK_VERSION}`,
        accept: "application/json",
        ...(opts.body !== undefined && { "content-type": "application/json" }),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ac.signal,
    }).finally(() => clearTimeout(t));
  }
}

/** null for a 2xx, otherwise the typed error (tolerates non-JSON bodies from proxies). */
async function toError(res: Response): Promise<SendspriteError | null> {
  if (res.ok) return null;
  const requestId = res.headers.get("x-request-id");
  const body = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown };
  } | null;
  const code =
    body?.error?.code ??
    (res.status === 429
      ? "rate_limited"
      : res.status >= 500
        ? "internal_error"
        : res.status === 404
          ? "not_found"
          : res.status === 401
            ? "unauthorized"
            : res.status === 403
              ? "forbidden"
              : "validation_error");
  return new SendspriteError(
    code as SendspriteError["code"],
    body?.error?.message ?? `HTTP ${res.status}`,
    res.status,
    body?.error?.details,
    requestId,
  );
}

const readEnv = (k: string) =>
  typeof process !== "undefined" ? process.env?.[k] : undefined;
```

(Write `request` cleanly — the sketch above compresses the branch on `res instanceof Response`; split it into an explicit `if` block. Keep the retry decisions exactly as tested: `retry` defaults to `true` for non-POST and `false` for POST; the resource layer (Task 6) passes `retry: true` for POSTs that are safe — cancel/verify/test — and for sends with an `idempotencyKey`.)

`packages/sdk/src/index.ts` for now:

```ts
export { SendspriteError, type SendspriteErrorCode } from "./errors";
export {
  type SendspriteOptions,
  type RequestOptions,
  SDK_VERSION,
} from "./client";
import { HttpClient, type SendspriteOptions } from "./client";
export class Sendsprite extends HttpClient {
  constructor(o?: SendspriteOptions) {
    super(o);
  }
}
```

- [ ] **Step 5: Run tests and build**

Run: `cd packages/sdk && bunx vitest run && bun run build && node -e "const {Sendsprite}=require('./dist/index.cjs');console.log(typeof Sendsprite)" && node --input-type=module -e "import {Sendsprite} from './dist/index.js';console.log(typeof Sendsprite)"`
Expected: tests pass; both print `function`. (`react`/`next` entries don't exist yet — temporarily list only `index` in tsup `entry`, the later tasks add them.)

- [ ] **Step 6: Root wiring + commit**

Root `bun install` (lockfile), then `bun run typecheck && bun run lint && bun run format && bun run test`.

```bash
git add packages/sdk bun.lock
git commit -m "feat(sdk): sendsprite package scaffold with retrying HTTP core and typed errors"
```

---

## Task 6: SDK resources — emails, domains, apiKeys, webhooks, suppressions, stats, me, stream

**Files:**

- Create: `packages/sdk/src/resources/{emails,domains,api-keys,webhooks,suppressions}.ts`, `packages/sdk/src/stream.ts`, `packages/sdk/src/types.ts`
- Modify: `packages/sdk/src/index.ts`
- Test: `packages/sdk/tests/resources.test.ts`, `packages/sdk/tests/stream.test.ts`

- [ ] **Step 1: Write the failing resources test**

`packages/sdk/tests/resources.test.ts` — one `it` per method asserting method + path + query/body; the pattern:

```ts
import { describe, expect, it, vi } from "vitest";
import { Sendsprite } from "../src/index";

function client(status = 200, body: unknown = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
  return {
    c: new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 0,
    }),
    fetch,
  };
}
const call = (fetch: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: init.method,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  };
};

describe("emails", () => {
  it("send → POST /emails, no retry without idempotencyKey", async () => {
    const { c, fetch } = client(201, { id: "em_1" });
    await expect(
      c.emails.send({ from: "a@b.io", to: "c@d.io", subject: "s", text: "t" }),
    ).resolves.toEqual({ id: "em_1" });
    expect(call(fetch)).toMatchObject({
      url: "https://x/api/v1/emails",
      method: "POST",
      body: { to: "c@d.io" },
    });
  });
  it("send with idempotencyKey retries a 503", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "em_1" }), { status: 201 }),
      );
    const c = new Sendsprite({
      apiKey: "k",
      baseUrl: "https://x",
      fetch,
      maxRetries: 1,
    });
    vi.useFakeTimers();
    const p = c.emails.send({
      from: "a@b.io",
      to: "c@d.io",
      subject: "s",
      text: "t",
      idempotencyKey: "i1",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toEqual({ id: "em_1" });
    vi.useRealTimers();
  });
  it("batch → POST /emails/batch", async () => {
    const { c, fetch } = client(201, { data: [{ id: "a" }] });
    await c.emails.batch([
      { from: "a@b.io", to: "c@d.io", subject: "s", text: "t" },
    ]);
    expect(call(fetch)).toMatchObject({
      url: "https://x/api/v1/emails/batch",
      method: "POST",
    });
  });
  it("get / list / cancel / reschedule", async () => {
    let r = client();
    await r.c.emails.get("em_1");
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/emails/em_1",
      method: "GET",
    });
    r = client(200, { data: [], nextCursor: null });
    await r.c.emails.list({ status: "sent", limit: 5, cursor: "c" });
    expect(call(r.fetch).url).toBe(
      "https://x/api/v1/emails?limit=5&cursor=c&status=sent",
    );
    r = client();
    await r.c.emails.cancel("em_1");
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/emails/em_1/cancel",
      method: "POST",
    });
    r = client();
    await r.c.emails.reschedule("em_1", {
      scheduledAt: "2030-01-01T00:00:00.000Z",
    });
    expect(call(r.fetch)).toMatchObject({
      method: "PATCH",
      body: { scheduledAt: "2030-01-01T00:00:00.000Z" },
    });
  });
});

describe("domains / apiKeys / webhooks / suppressions / stats / me", () => {
  it("domains", async () => {
    let r = client(200, { data: [], nextCursor: null });
    await r.c.domains.list();
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/domains",
      method: "GET",
    });
    r = client(201);
    await r.c.domains.create({ name: "mail.x.io" });
    expect(call(r.fetch)).toMatchObject({
      method: "POST",
      body: { name: "mail.x.io" },
    });
    r = client();
    await r.c.domains.get("d1");
    expect(call(r.fetch).url).toBe("https://x/api/v1/domains/d1");
    r = client();
    await r.c.domains.verify("d1");
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/domains/d1/verify",
      method: "POST",
    });
    r = client(204, undefined);
    await r.c.domains.delete("d1");
    expect(call(r.fetch).method).toBe("DELETE");
  });
  it("apiKeys", async () => {
    let r = client(200, { data: [], nextCursor: null });
    await r.c.apiKeys.list();
    r = client(201, { id: "k", secret: "ss_live_1" });
    await expect(r.c.apiKeys.create({ name: "ci" })).resolves.toEqual({
      id: "k",
      secret: "ss_live_1",
    });
    r = client(204, undefined);
    await r.c.apiKeys.revoke("k");
    expect(call(r.fetch)).toMatchObject({
      url: "https://x/api/v1/api-keys/k",
      method: "DELETE",
    });
  });
  it("webhooks", async () => {
    let r = client(201, { id: "w", secret: "whsec_1" });
    await r.c.webhooks.create({
      url: "https://h.io/x",
      events: ["email.sent"],
    });
    r = client();
    await r.c.webhooks.update("w", { enabled: false });
    expect(call(r.fetch)).toMatchObject({
      method: "PATCH",
      body: { enabled: false },
    });
    r = client(202, { deliveryId: "dl" });
    await r.c.webhooks.test("w");
    expect(call(r.fetch).url).toBe("https://x/api/v1/webhooks/w/test");
    r = client(204, undefined);
    await r.c.webhooks.delete("w");
  });
  it("suppressions encode the email path segment", async () => {
    let r = client(201);
    await r.c.suppressions.add({ email: "a+tag@b.io" });
    r = client(204, undefined);
    await r.c.suppressions.remove("a+tag@b.io");
    expect(call(r.fetch).url).toBe(
      "https://x/api/v1/suppressions/a%2Btag%40b.io",
    );
  });
  it("stats and me", async () => {
    let r = client();
    await r.c.stats();
    expect(call(r.fetch).url).toBe("https://x/api/v1/stats");
    r = client();
    await r.c.me();
    expect(call(r.fetch).url).toBe("https://x/api/v1/me");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && bunx vitest run tests/resources.test.ts`
Expected: FAIL — `c.emails` undefined.

- [ ] **Step 3: Implement resources**

`packages/sdk/src/types.ts` re-exports the shared types the public API uses (types only — keeps the bundle small even though shared is inlined):

```ts
export type {
  SendEmailInput,
  BatchSendInput,
  EmailObject,
  EmailDetail,
  EmailEventObject,
  EmailStatus,
  EmailEventType,
  ListQuery,
  PatchEmailInput,
  CreateDomainInput,
  DomainObject,
  DnsRecordObject,
  CreateApiKeyInput,
  ApiKeyObject,
  ApiKeyCreated,
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookObject,
  WebhookCreated,
  WebhookEventType,
  WebhookPayload,
  AddSuppressionInput,
  SuppressionObject,
  SendStatsObject,
  MeObject,
  StreamChange,
  ErrorCode,
  PageQuery,
} from "@sendsprite/shared";
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}
```

`packages/sdk/src/resources/emails.ts`:

```ts
import type { HttpClient } from "../client";
import type {
  BatchSendInput,
  EmailDetail,
  EmailObject,
  ListQuery,
  Page,
  PatchEmailInput,
  SendEmailInput,
} from "../types";

export class Emails {
  constructor(private readonly http: HttpClient) {}
  /** 201 `{ id }`; a replayed `idempotencyKey` returns the earlier id. Retries only when an idempotencyKey is set. */
  send(input: SendEmailInput): Promise<{ id: string }> {
    return this.http.request("POST", "/emails", {
      body: input,
      retry: Boolean(input.idempotencyKey),
    });
  }
  batch(input: BatchSendInput): Promise<{ data: { id: string }[] }> {
    return this.http.request("POST", "/emails/batch", {
      body: input,
      retry: input.every((e) => e.idempotencyKey),
    });
  }
  get(id: string): Promise<EmailDetail> {
    return this.http.request("GET", `/emails/${enc(id)}`);
  }
  list(q: Partial<ListQuery> = {}): Promise<Page<EmailObject>> {
    return this.http.request("GET", "/emails", { query: q });
  }
  cancel(id: string): Promise<EmailObject> {
    return this.http.request("POST", `/emails/${enc(id)}/cancel`, {
      retry: true,
    });
  }
  reschedule(id: string, input: PatchEmailInput): Promise<EmailObject> {
    return this.http.request("PATCH", `/emails/${enc(id)}`, { body: input });
  }
  /** Walks every page. */
  async *iterate(
    q: Omit<Partial<ListQuery>, "cursor"> = {},
  ): AsyncGenerator<EmailObject> {
    let cursor: string | undefined;
    do {
      const page: Page<EmailObject> = await this.list({ ...q, cursor });
      yield* page.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
}
export const enc = encodeURIComponent;
```

Same style for `Domains` (`list(q?)`, `create`, `get`, `verify` (retry true), `delete` → `Promise<{ leftoverDnsRecords: number } | void>` (200 with a count of Cloudflare records that need manual cleanup, else 204)), `ApiKeys` (`list`, `create`, `revoke`), `Webhooks` (`list`, `create`, `update`, `test` (retry true), `delete`), `Suppressions` (`list`, `add`, `remove(email)` with `enc`). Query key order for `list`: pass `{ limit, cursor, ...rest }` so the URL in the test (`limit=5&cursor=c&status=sent`) is produced — build the object in that order in `HttpClient.request` is not enough; construct it in the resource: `{ limit: q.limit, cursor: q.cursor, status: q.status, to: q.to, domainId: q.domainId, tag: q.tag }`.

`packages/sdk/src/index.ts`:

```ts
export class Sendsprite {
  readonly emails: Emails;
  readonly domains: Domains;
  readonly apiKeys: ApiKeys;
  readonly webhooks: Webhooks;
  readonly suppressions: Suppressions;
  private readonly http: HttpClient;
  constructor(o?: SendspriteOptions) {
    this.http = new HttpClient(o);
    this.emails = new Emails(this.http); /* … */
  }
  get baseUrl() {
    return this.http.baseUrl;
  }
  /** Escape hatch for endpoints without a helper. */
  request<T>(method: string, path: string, opts?: RequestOptions) {
    return this.http.request<T>(method, path, opts);
  }
  stats(): Promise<SendStatsObject> {
    return this.http.request("GET", "/stats");
  }
  me(): Promise<MeObject> {
    return this.http.request("GET", "/me");
  }
  /** Live change feed (`/api/v1/stream`); see stream.ts. */
  stream(opts?: StreamOptions) {
    return openStream(this.http, opts);
  }
}
export * from "./types";
export { SendspriteError } from "./errors";
```

- [ ] **Step 4: Write the failing stream test**

`packages/sdk/tests/stream.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { Sendsprite } from "../src/index";

const sse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        const e = new TextEncoder();
        for (const ch of chunks) c.enqueue(e.encode(ch));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

describe("client.stream()", () => {
  it("parses change events and ignores comments; resolves when the server closes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        sse([
          ": connected\n\n",
          'event: change\ndata: {"type":"email","id":"em_1"}\n\n',
          ": ping\n\n",
          'event: change\ndata: {"type":"webhook"}\n\n',
        ]),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const seen: unknown[] = [];
    const s = c.stream({ onChange: (e) => seen.push(e), reconnect: false });
    await s.done;
    expect(seen).toEqual([{ type: "email", id: "em_1" }, { type: "webhook" }]);
    expect(
      new Headers((fetch.mock.calls[0]![1] as RequestInit).headers).get(
        "authorization",
      ),
    ).toBe("Bearer k");
    expect(fetch.mock.calls[0]![0]).toBe("https://x/api/v1/stream");
  });
  it("close() aborts the request", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(
        (_u, init) =>
          new Promise((_, rej) =>
            init!.signal!.addEventListener("abort", () =>
              rej(new DOMException("aborted", "AbortError")),
            ),
          ),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    const s = c.stream({ onChange: () => {}, reconnect: false });
    s.close();
    await expect(s.done).resolves.toBeUndefined();
  });
  it("surfaces a 403 as SendspriteError", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "forbidden", message: "full key required" },
        }),
        { status: 403 },
      ),
    );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await expect(
      c.stream({ onChange: () => {}, reconnect: false }).done,
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
```

- [ ] **Step 5: Implement `stream.ts`**

Fetch-based SSE parser (no `eventsource` dependency needed for the SDK — keep `eventsource` only if the CLI wants it; otherwise drop it from `dependencies`):

```ts
import type { HttpClient } from "./client";
import { SendspriteError } from "./errors";
import type { StreamChange } from "./types";

export interface StreamOptions {
  onChange: (change: StreamChange) => void;
  onError?: (err: SendspriteError) => void;
  /** Reconnect with backoff after a dropped connection (default true). */
  reconnect?: boolean;
  signal?: AbortSignal;
}
export interface StreamHandle {
  close(): void;
  readonly done: Promise<void>;
}

export function openStream(
  http: HttpClient,
  opts: StreamOptions,
): StreamHandle {
  const ac = new AbortController();
  opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
  const done = (async () => {
    let attempt = 0;
    while (!ac.signal.aborted) {
      try {
        await http.raw(
          "GET",
          "/stream",
          { accept: "text/event-stream" },
          ac.signal,
          async (res) => {
            attempt = 0;
            for await (const ev of parseSse(res.body!))
              if (ev.event === "change") opts.onChange(JSON.parse(ev.data));
          },
        );
        if (opts.reconnect === false) return;
      } catch (e) {
        if (ac.signal.aborted) return;
        const err =
          e instanceof SendspriteError
            ? e
            : new SendspriteError("network_error", String(e), null);
        if (!err.retryable || opts.reconnect === false) throw err;
        opts.onError?.(err);
      }
      await new Promise((r) =>
        setTimeout(r, Math.min(30_000, 1_000 * 2 ** attempt++)),
      );
    }
  })();
  return {
    close: () => ac.abort(),
    done: done.catch((e) => {
      if (!ac.signal.aborted) throw e;
    }),
  };
}

/** Minimal SSE parser: `event:` + `data:` lines, blank line dispatches, `:` comments ignored. */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") };
        event = "message";
        data = [];
      } else if (line.startsWith(":")) continue;
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:"))
        data.push(line.slice(5).replace(/^ /, ""));
    }
  }
}
```

Add `HttpClient.raw(method, path, headers, signal, consume)` — one authenticated fetch without JSON parsing/retry; a non-2xx status goes through the same `toError` and throws.

- [ ] **Step 6: Run, build, commit**

Run: `cd packages/sdk && bunx vitest run && bun run build && cd ../.. && bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add packages/sdk
git commit -m "feat(sdk): resource namespaces, pagination iterator and SSE change stream"
```

---

## Task 7: `sendsprite/react` — React Email primitives + `renderEmail`, and `emails.send({ react })`

**Files:**

- Create: `packages/sdk/src/react.tsx`, `packages/sdk/src/render.ts`
- Modify: `packages/sdk/src/resources/emails.ts`, `packages/sdk/tsup.config.ts` (add `react` entry)
- Test: `packages/sdk/tests/react.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from "vitest";
import { Button, Html, Text, renderEmail } from "../src/react";
import { Sendsprite } from "../src/index";

describe("sendsprite/react", () => {
  it("renders an element to html + text", async () => {
    const out = await renderEmail(
      <Html>
        <Text>Hello {"Ada"}</Text>
        <Button href="https://x.io">Go</Button>
      </Html>,
    );
    expect(out.html).toContain("<!DOCTYPE html");
    expect(out.html).toContain("Hello Ada");
    expect(out.text).toContain("Hello Ada");
    expect(out.text).toContain("https://x.io");
  });

  it("emails.send({ react }) renders before posting and drops the element from the body", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "em" }), { status: 201 }),
      );
    const c = new Sendsprite({ apiKey: "k", baseUrl: "https://x", fetch });
    await c.emails.send({
      from: "a@b.io",
      to: "c@d.io",
      subject: "s",
      react: <Text>Hi</Text>,
    });
    const body = JSON.parse(
      (fetch.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.react).toBeUndefined();
    expect(body.html).toContain("Hi");
    expect(body.text).toContain("Hi");
  });

  it("send({ react }) without @react-email/render installed fails with a clear error", async () => {
    vi.doMock("@react-email/render", () => {
      throw new Error("Cannot find module");
    });
    const { renderEmail: r } = await import("../src/react?fresh");
    await expect(r(<Text>x</Text>)).rejects.toThrow(
      /install @react-email\/render/,
    );
    vi.doUnmock("@react-email/render");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && bunx vitest run tests/react.test.tsx`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`packages/sdk/src/render.ts` (shared by `react.tsx` and the emails resource; dynamic import keeps `@react-email/render` optional):

```ts
import type { ReactElement } from "react";

export interface Rendered {
  html: string;
  text: string;
}

export async function renderEmail(element: ReactElement): Promise<Rendered> {
  let mod: typeof import("@react-email/render");
  try {
    mod = await import("@react-email/render");
  } catch {
    throw new Error(
      "sendsprite: sending `react` requires the optional peer dependency — install @react-email/render (and @react-email/components for the primitives).",
    );
  }
  const [html, text] = await Promise.all([
    mod.render(element),
    mod.render(element, { plainText: true }),
  ]);
  return { html, text };
}
```

`packages/sdk/src/react.tsx`:

```tsx
/**
 * `sendsprite/react`: React Email primitives re-exported for convenience, plus
 * `renderEmail`. Server-side only (no hooks) — render in a route handler or
 * server action, then send the html/text.
 */
export * from "@react-email/components";
export { renderEmail, type Rendered } from "./render";
```

`Emails.send` / `batch` accept `SendEmailInput & { react?: ReactElement }` (type `SendEmailOptions`); when `react` is present, `await renderEmail(react)` fills `html`/`text` (explicit `html`/`text` win if given), and the `react` key is removed before posting. Add `react` to the tsup `entry`. `vitest.config.ts` needs `esbuild: { jsx: "automatic" }` (or `@vitejs/plugin-react` — prefer the esbuild option, no extra dep).

- [ ] **Step 4: Run, build, commit**

Run: `cd packages/sdk && bunx vitest run && bun run build && ls dist/react.js dist/react.cjs dist/react.d.ts && cd ../.. && bun run typecheck && bun run lint && bun run format && bun run test`

```bash
git add packages/sdk
git commit -m "feat(sdk): sendsprite/react — React Email primitives, renderEmail, and emails.send({ react })"
```

---

## Task 8: `sendsprite/next` — `verifyWebhook` and `createWebhookHandler`

**Files:**

- Create: `packages/sdk/src/next.ts`
- Modify: `packages/sdk/tsup.config.ts` (add `next` entry)
- Test: `packages/sdk/tests/next.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  signWebhook,
  SIGNATURE_HEADER,
  EVENT_ID_HEADER,
} from "@sendsprite/shared/node";
import {
  createWebhookHandler,
  verifyWebhook,
  WebhookVerificationError,
} from "../src/next";

const secret = "whsec_test";
const payload = {
  id: "evt_1",
  type: "email.delivered",
  createdAt: "2026-01-01T00:00:00.000Z",
  data: { id: "em_1" },
};
const signed = (body: string, ts = Math.floor(Date.now() / 1000)) =>
  new Request("https://app/api/webhooks/sendsprite", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [SIGNATURE_HEADER]: signWebhook(secret, ts, body),
      [EVENT_ID_HEADER]: "evt_1",
    },
    body,
  });

describe("verifyWebhook", () => {
  it("returns the typed payload for a valid signature", async () => {
    const ev = await verifyWebhook(signed(JSON.stringify(payload)), secret);
    expect(ev).toEqual(payload);
  });
  it("rejects a bad signature and a stale timestamp", async () => {
    const req = signed(JSON.stringify(payload));
    const tampered = new Request(req, {
      body: JSON.stringify({ ...payload, type: "email.bounced" }),
    });
    await expect(verifyWebhook(tampered, secret)).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
    await expect(
      verifyWebhook(signed(JSON.stringify(payload), 1_000), secret),
    ).rejects.toBeInstanceOf(WebhookVerificationError);
  });
});

describe("createWebhookHandler", () => {
  it("dispatches to the matching handler and returns 200", async () => {
    const delivered = vi.fn();
    const POST = createWebhookHandler({
      secret,
      on: { "email.delivered": delivered },
    });
    const res = await POST(signed(JSON.stringify(payload)));
    expect(res.status).toBe(200);
    expect(delivered).toHaveBeenCalledWith(payload);
  });
  it("returns 401 on a bad signature and 200 for events without a handler", async () => {
    const POST = createWebhookHandler({ secret, on: {} });
    expect(
      (await POST(new Request("https://app", { method: "POST", body: "{}" })))
        .status,
    ).toBe(401);
    expect((await POST(signed(JSON.stringify(payload)))).status).toBe(200);
  });
  it("returns 500 when a handler throws so Sendsprite retries", async () => {
    const POST = createWebhookHandler({
      secret,
      on: {
        "email.delivered": () => {
          throw new Error("db down");
        },
      },
    });
    expect((await POST(signed(JSON.stringify(payload)))).status).toBe(500);
  });
});
```

(Check the exact `signWebhook(secret, timestamp, body)` argument order and header format in `packages/shared/src/api/webhook-signature.ts` and mirror what `services/webhooks.ts deliver()` sends.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && bunx vitest run tests/next.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import {
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  type WebhookEventType,
  type WebhookPayload,
} from "@sendsprite/shared";
import { verifyWebhookSignature } from "@sendsprite/shared/node";

export class WebhookVerificationError extends Error {
  readonly name = "WebhookVerificationError";
}

/** Reads the raw body, checks `sendsprite-signature`, returns the payload. Throws WebhookVerificationError. */
export async function verifyWebhook<T = Record<string, unknown>>(
  req: Request,
  secret: string,
): Promise<WebhookPayload<T>> {
  const sig = req.headers.get(SIGNATURE_HEADER);
  if (!sig)
    throw new WebhookVerificationError(`Missing ${SIGNATURE_HEADER} header.`);
  const body = await req.text();
  if (!verifyWebhookSignature(secret, sig, body))
    throw new WebhookVerificationError("Invalid webhook signature.");
  return JSON.parse(body) as WebhookPayload<T>;
}

type Handlers = Partial<
  Record<WebhookEventType, (event: WebhookPayload) => void | Promise<void>>
>;

/**
 * Route handler for `app/api/webhooks/sendsprite/route.ts`:
 *   export const POST = createWebhookHandler({ secret: process.env.SENDSPRITE_WEBHOOK_SECRET!, on: { "email.bounced": … } })
 * 401 on bad signature, 500 if a handler throws (Sendsprite retries), 200 otherwise.
 */
export function createWebhookHandler(opts: {
  secret: string;
  on: Handlers;
  onUnhandled?: (event: WebhookPayload) => void | Promise<void>;
}) {
  return async (req: Request): Promise<Response> => {
    let event: WebhookPayload;
    try {
      event = await verifyWebhook(req, opts.secret);
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? e.message : "invalid" },
        { status: 401 },
      );
    }
    try {
      const h = opts.on[event.type as WebhookEventType] ?? opts.onUnhandled;
      await h?.(event);
      return Response.json({
        received: true,
        id: req.headers.get(EVENT_ID_HEADER),
      });
    } catch (e) {
      console.error("[sendsprite webhook]", e);
      return Response.json({ error: "handler failed" }, { status: 500 });
    }
  };
}
```

Adjust `verifyWebhookSignature`'s argument order to the real signature. The `next` bundle must mark nothing external (`@sendsprite/shared/node` is inlined; `node:crypto` stays a runtime built-in) — confirm `dist/next.js` has `import ... from "node:crypto"` and nothing from `@sendsprite/shared`.

- [ ] **Step 4: Run, build, commit**

```bash
cd packages/sdk && bunx vitest run && bun run build && grep -c "@sendsprite/shared" dist/next.js   # expect 0
cd ../.. && bun run typecheck && bun run lint && bun run format && bun run test
git add packages/sdk
git commit -m "feat(sdk): sendsprite/next — verifyWebhook and createWebhookHandler"
```

---

## Task 9: CLI — `npx sendsprite login | whoami | domains list | emails send | emails tail`

**Files:**

- Create: `packages/sdk/src/cli/index.ts`, `packages/sdk/src/cli/config.ts`, `packages/sdk/src/cli/output.ts`, `packages/sdk/src/cli/commands/{login,whoami,domains,emails}.ts`
- Test: `packages/sdk/tests/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Test the command layer through an injected client + writer (no process spawning):

```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli/index";
import { loadConfig, saveConfig } from "../src/cli/config";

const dir = () => mkdtempSync(join(tmpdir(), "ss-cli-"));
const fakeClient = () => ({
  me: vi.fn().mockResolvedValue({
    team: { id: "t", name: "Acme" },
    apiKey: {
      id: "k",
      name: "ci",
      permission: "full",
      keyPrefix: "ss_live_ab",
      domainId: null,
    },
  }),
  domains: {
    list: vi.fn().mockResolvedValue({
      data: [
        {
          id: "d1",
          name: "mail.x.io",
          status: "verified",
          dnsMode: "cloudflare",
          region: "us-east-1",
          records: [],
          lastError: null,
          createdAt: "",
          verifiedAt: "",
        },
      ],
      nextCursor: null,
    }),
  },
  emails: {
    send: vi.fn().mockResolvedValue({ id: "em_1" }),
    get: vi.fn().mockResolvedValue({
      id: "em_1",
      status: "sent",
      to: ["c@d.io"],
      subject: "s",
    }),
  },
  stream: vi.fn(),
});
const run = async (
  argv: string[],
  client = fakeClient(),
  configDir = dir(),
) => {
  const out: string[] = [];
  const program = buildProgram({
    configDir,
    createClient: () => client as never,
    write: (s) => out.push(s),
    env: {},
  });
  await program.parseAsync(["node", "sendsprite", ...argv]);
  return { out: out.join("\n"), client, configDir };
};

describe("cli", () => {
  it("login saves url + key and verifies with /me", async () => {
    const { out, configDir, client } = await run([
      "login",
      "--url",
      "https://mail.acme.com",
      "--api-key",
      "ss_live_1",
    ]);
    expect(client.me).toHaveBeenCalled();
    expect(loadConfig(configDir)).toEqual({
      url: "https://mail.acme.com",
      apiKey: "ss_live_1",
    });
    expect(out).toContain("Logged in to Acme");
    expect(readFileSync(join(configDir, "config.json"), "utf8")).toContain(
      "ss_live_1",
    );
  });
  it("whoami prints team and key", async () => {
    const d = dir();
    saveConfig(d, { url: "https://x", apiKey: "k" });
    const { out } = await run(["whoami"], fakeClient(), d);
    expect(out).toMatch(/Acme.*t/s);
    expect(out).toContain("ss_live_ab");
  });
  it("commands other than login fail clearly when not logged in", async () => {
    await expect(run(["whoami"])).rejects.toThrow(/sendsprite login/);
  });
  it("domains list renders a table and --json raw", async () => {
    const d = dir();
    saveConfig(d, { url: "https://x", apiKey: "k" });
    expect((await run(["domains", "list"], fakeClient(), d)).out).toMatch(
      /mail\.x\.io\s+verified/,
    );
    expect(
      JSON.parse(
        (await run(["domains", "list", "--json"], fakeClient(), d)).out,
      )[0].id,
    ).toBe("d1");
  });
  it("emails send maps flags to SendEmailInput", async () => {
    const d = dir();
    saveConfig(d, { url: "https://x", apiKey: "k" });
    const { client, out } = await run(
      [
        "emails",
        "send",
        "--from",
        "a@b.io",
        "--to",
        "c@d.io",
        "--to",
        "e@f.io",
        "--subject",
        "hi",
        "--text",
        "body",
        "--tag",
        "env=ci",
      ],
      fakeClient(),
      d,
    );
    expect(client.emails.send).toHaveBeenCalledWith({
      from: "a@b.io",
      to: ["c@d.io", "e@f.io"],
      subject: "hi",
      text: "body",
      tags: { env: "ci" },
    });
    expect(out).toContain("em_1");
  });
  it("emails tail subscribes to the stream and prints email changes", async () => {
    const d = dir();
    saveConfig(d, { url: "https://x", apiKey: "k" });
    const client = fakeClient();
    client.stream.mockImplementation(
      ({ onChange }: { onChange: (c: unknown) => void }) => {
        onChange({ type: "email", id: "em_1" });
        return { close() {}, done: Promise.resolve() };
      },
    );
    const { out } = await run(["emails", "tail"], client, d);
    expect(client.emails.get).toHaveBeenCalledWith("em_1");
    expect(out).toMatch(/em_1\s+sent\s+c@d\.io\s+s/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/sdk && bunx vitest run tests/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`config.ts`: `defaultConfigDir()` = `$SENDSPRITE_CONFIG_DIR` or `$XDG_CONFIG_HOME/sendsprite` or `~/.config/sendsprite` (`%APPDATA%\sendsprite` on Windows); `loadConfig(dir)` → `{ url, apiKey } | null`; `saveConfig(dir, cfg)` writes `config.json` with mode `0o600` and `mkdir -p`. Env `SENDSPRITE_API_KEY`/`SENDSPRITE_URL` override the file.

`index.ts`:

```ts
import { Command } from "commander";
import { Sendsprite } from "../index";
import { defaultConfigDir, loadConfig } from "./config";
import { SDK_VERSION } from "../client";

export interface CliDeps {
  configDir: string;
  createClient: (cfg: { url: string; apiKey: string }) => Sendsprite;
  write: (line: string) => void;
  env: NodeJS.ProcessEnv;
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command("sendsprite")
    .version(SDK_VERSION)
    .description("Sendsprite CLI")
    .exitOverride();
  const client = () => {
    const cfg = {
      url: deps.env.SENDSPRITE_URL,
      apiKey: deps.env.SENDSPRITE_API_KEY,
      ...loadConfig(deps.configDir),
    };
    if (!cfg.url || !cfg.apiKey)
      throw new Error(
        "Not logged in. Run `sendsprite login --url <instance> --api-key <key>` or set SENDSPRITE_URL and SENDSPRITE_API_KEY.",
      );
    return deps.createClient(cfg as { url: string; apiKey: string });
  };
  registerLogin(program, deps);
  registerWhoami(program, client, deps.write);
  registerDomains(program, client, deps.write);
  registerEmails(program, client, deps.write);
  return program;
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/cli.js") ||
  process.argv[1]?.endsWith("\\cli.js")
) {
  buildProgram({
    configDir: defaultConfigDir(),
    createClient: (c) => new Sendsprite({ baseUrl: c.url, apiKey: c.apiKey }),
    write: (l) => process.stdout.write(l + "\n"),
    env: process.env,
  })
    .parseAsync(process.argv)
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
```

(Simplest reliable guard: move the `main` call into a separate `src/cli/bin.ts` that is the tsup `cli` entry and always runs; `index.ts` only exports `buildProgram`. Do that instead of the `import.meta.url` check.)

Commands:

- `login --url <url> --api-key <key>` (prompt for missing values via `node:readline/promises` only when `process.stdin.isTTY`; otherwise error): creates the client, calls `me()`, saves, prints `Logged in to <team.name> as <apiKey.name> (<keyPrefix>…)`.
- `whoami`: prints `Team  Acme (t)` / `Key   ci (ss_live_ab…) · full`.
- `domains list [--json]`: table `NAME  STATUS  MODE  REGION  ID` via a tiny `table(rows)` in `output.ts` (pad columns; no dependency).
- `emails send --from --to (repeatable) --cc --bcc --reply-to --subject --text --html --html-file <path> --tag k=v (repeatable) --schedule <iso> --idempotency-key --json`: builds `SendEmailInput` (omit undefined keys — the test asserts the exact object), prints `Queued em_1` or JSON.
- `emails tail [--json]`: `client.stream({ onChange })`; for `type === "email"` fetch `emails.get(id)` and print `id status to subject` (or the JSON); handle SIGINT → `close()`; awaits `done`.

- [ ] **Step 4: Smoke the built binary**

Run: `cd packages/sdk && bunx vitest run && bun run build && node dist/cli.js --help && node dist/cli.js whoami; echo "exit=$?"`
Expected: help text; `whoami` prints the not-logged-in message and exits 1.

- [ ] **Step 5: Commit**

```bash
cd ../.. && bun run typecheck && bun run lint && bun run format && bun run test
git add packages/sdk
git commit -m "feat(cli): npx sendsprite login/whoami/domains list/emails send/emails tail"
```

---

## Task 10: `@sendsprite/mcp` — stdio + streamable HTTP server

**Files:**

- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/tsup.config.ts`, `packages/mcp/vitest.config.ts`, `packages/mcp/README.md`, `packages/mcp/src/server.ts`, `packages/mcp/src/tools/{send-email,get-email-status,list-emails,search-emails,list-domains,get-send-stats}.ts`, `packages/mcp/src/bin.ts`
- Test: `packages/mcp/tests/server.test.ts`

- [ ] **Step 1: Scaffold**

`package.json`: name `@sendsprite/mcp`, `bin: { "sendsprite-mcp": "./dist/bin.js" }`, `dependencies`: `@modelcontextprotocol/sdk ^1.30.0`, `sendsprite: workspace:*` (published as a normal semver range by changesets), `zod ^4.4.3`; `devDependencies`: `@sendsprite/shared workspace:*`, tsup, vitest, `@types/node`. tsup: entries `index` (lib: `createServer`) and `bin`, ESM only, `noExternal: ["@sendsprite/shared"]`, `external: ["sendsprite", "@modelcontextprotocol/sdk", "zod"]`, banner shebang on `bin`.

- [ ] **Step 2: Write the failing test** (in-memory transport, fake client)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../src/server";

const fake = () => ({
  emails: {
    send: vi.fn().mockResolvedValue({ id: "em_1" }),
    get: vi.fn().mockResolvedValue({
      id: "em_1",
      status: "delivered",
      to: ["c@d.io"],
      subject: "s",
      events: [{ type: "delivered", occurredAt: "t", payload: {} }],
    }),
    list: vi.fn().mockResolvedValue({
      data: [
        {
          id: "em_1",
          status: "sent",
          to: ["c@d.io"],
          subject: "s",
          createdAt: "t",
        },
      ],
      nextCursor: null,
    }),
  },
  domains: {
    list: vi.fn().mockResolvedValue({
      data: [{ id: "d1", name: "mail.x.io", status: "verified" }],
      nextCursor: null,
    }),
  },
  stats: vi.fn().mockResolvedValue({
    sent: { today: 1, d7: 2, d30: 3 },
    rates: { delivered: 1, bounced: 0, complained: 0 },
    alerts: [],
  }),
});

async function connect(client = fake()) {
  const server = createServer(client as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  return { c, client };
}

describe("@sendsprite/mcp", () => {
  it("lists the six tools", async () => {
    const { c } = await connect();
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_email_status",
      "get_send_stats",
      "list_domains",
      "list_emails",
      "search_emails",
      "send_email",
    ]);
  });
  it("send_email validates input and calls the SDK", async () => {
    const { c, client } = await connect();
    const r = await c.callTool({
      name: "send_email",
      arguments: { from: "a@b.io", to: ["c@d.io"], subject: "s", text: "t" },
    });
    expect(client.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "s" }),
    );
    expect(r.structuredContent).toEqual({ id: "em_1" });
    const bad = await c.callTool({
      name: "send_email",
      arguments: { from: "a@b.io" },
    });
    expect(bad.isError).toBe(true);
  });
  it("get_email_status returns status + recent events", async () => {
    const { c } = await connect();
    const r = await c.callTool({
      name: "get_email_status",
      arguments: { id: "em_1" },
    });
    expect(r.structuredContent).toMatchObject({
      id: "em_1",
      status: "delivered",
    });
  });
  it("search_emails maps query fields onto the list filters", async () => {
    const { c, client } = await connect();
    await c.callTool({
      name: "search_emails",
      arguments: { to: "c@d.io", status: "sent", limit: 5 },
    });
    expect(client.emails.list).toHaveBeenCalledWith({
      to: "c@d.io",
      status: "sent",
      limit: 5,
    });
  });
  it("SDK errors become isError tool results, not protocol errors", async () => {
    const client = fake();
    client.emails.get.mockRejectedValue(
      Object.assign(new Error("nope"), {
        name: "SendspriteError",
        code: "not_found",
        status: 404,
      }),
    );
    const { c } = await connect(client);
    const r = await c.callTool({
      name: "get_email_status",
      arguments: { id: "x" },
    });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("not_found");
  });
});
```

- [ ] **Step 3: Run to verify it fails**, then implement

`src/server.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Sendsprite } from "sendsprite";
import { registerSendEmail } from "./tools/send-email";
/* … one import per tool … */

export function createServer(client: Sendsprite): McpServer {
  const server = new McpServer({ name: "sendsprite", version: MCP_VERSION });
  for (const register of [
    registerSendEmail,
    registerGetEmailStatus,
    registerListEmails,
    registerSearchEmails,
    registerListDomains,
    registerGetSendStats,
  ])
    register(server, client);
  return server;
}
```

Tool pattern (`tools/send-email.ts`):

```ts
import { z } from "zod";
import { SendEmailInput } from "@sendsprite/shared";
import { toolResult, toolError } from "./result";

export const registerSendEmail = (server: McpServer, client: Sendsprite) =>
  server.registerTool(
    "send_email",
    {
      title: "Send an email",
      description:
        "Send a transactional email through the connected Sendsprite instance. `from` must use a verified domain. Returns the email id.",
      inputSchema: SendEmailInput.shape,
      outputSchema: { id: z.string() },
    },
    async (input) => {
      try {
        return toolResult(await client.emails.send(input));
      } catch (e) {
        return toolError(e);
      }
    },
  );
```

`tools/result.ts`: `toolResult(data)` → `{ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data }`; `toolError(e)` → `{ isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message, status } }) }] }`.

Other tools' inputs: `get_email_status { id }` → `emails.get`, returns `{ id, status, to, subject, sentAt, lastError, events: last 10 }`; `list_emails { limit?, cursor?, status? }`; `search_emails { to?, status?, tag?, domainId?, limit? }` (both → `emails.list`); `list_domains {}`; `get_send_stats {}` → `client.stats()`.

`src/bin.ts`: env `SENDSPRITE_URL` + `SENDSPRITE_API_KEY` required; `--http [port]` → `StreamableHTTPServerTransport` behind a tiny `node:http` server at `POST /mcp` (stateless: new transport per request, `sessionIdGenerator: undefined`), default → `StdioServerTransport`. Log to stderr only.

- [ ] **Step 4: Run, build, smoke, commit**

```bash
cd packages/mcp && bunx vitest run && bun run build && SENDSPRITE_URL=http://x SENDSPRITE_API_KEY=k timeout 3 node dist/bin.js --http 0 || true
cd ../.. && bun install && bun run typecheck && bun run lint && bun run format && bun run test
git add packages/mcp bun.lock
git commit -m "feat(mcp): @sendsprite/mcp server with send/status/list/search/domains/stats tools (stdio + streamable HTTP)"
```

---

## Task 11: Docs site — `/docs` MDX pages and `/docs/api` (Scalar)

**Files:**

- Create: `apps/web/src/mdx-components.tsx`, `apps/web/src/app/docs/layout.tsx`, `apps/web/src/app/docs/nav.ts`, `apps/web/src/app/docs/page.mdx`, `apps/web/src/app/docs/{self-hosting,domains,sending,webhooks,sdk,cli,mcp,api-keys}/page.mdx`, `apps/web/src/app/docs/api/route.ts`
- Modify: `apps/web/next.config.ts`, `apps/web/package.json` (`@next/mdx`, `@mdx-js/loader`, `@mdx-js/react`, `@types/mdx`, `@scalar/nextjs-api-reference`)
- Test: `apps/web/tests/e2e/docs.spec.ts`

- [ ] **Step 1: Wire MDX**

`next.config.ts`: `import createMDX from "@next/mdx"; const withMDX = createMDX({}); … pageExtensions: ["ts", "tsx", "mdx"] … export default withMDX(nextConfig);`. `src/mdx-components.tsx` maps `h1..h3, p, a, pre, code, table` to themed classes (`hairline` dividers, `font-mono` code, prose widths). MDX pages are static content but the root layout is `force-dynamic` — fine, they render per request.

- [ ] **Step 2: Docs shell**

`docs/nav.ts`: `[{ title: "Getting started", href: "/docs" }, { title: "Self-hosting", href: "/docs/self-hosting" }, { title: "Domains", href: "/docs/domains" }, { title: "Sending", href: "/docs/sending" }, { title: "API keys", href: "/docs/api-keys" }, { title: "Webhooks", href: "/docs/webhooks" }, { title: "SDK (sendsprite)", href: "/docs/sdk" }, { title: "CLI", href: "/docs/cli" }, { title: "MCP server", href: "/docs/mcp" }, { title: "API reference", href: "/docs/api" }]`. Layout: left sidebar (`glass` panel, `num-stamp` section labels), content column max 72ch, top bar with "Sendsprite" → `/`, "Dashboard" → `/app`. Sidebar collapses to a `<details>` under `md`.

- [ ] **Step 3: Write the pages** — real content, each ≥ the bullets below:

- `page.mdx` (Getting started): install (`bunx`/`npx sendsprite login`), create a key in Settings → API keys, first send with curl and with the SDK, where to look (`/app/emails`).
- `self-hosting`: `install.sh` one-liner, `docker-compose.yml` walkthrough, required env (`APP_SECRET`, `DATABASE_URL`, `APP_URL`), the one-click AWS CloudFormation setup and the manual-keys path, Cloudflare token scopes, SES sandbox exit, worker profile, upgrades (`docker compose pull`), backups.
- `domains`: add domain, DNS records table meaning (DKIM ×3, MAIL FROM MX/SPF, DMARC), Cloudflare auto mode, verification timing, troubleshooting.
- `sending`: `SendEmailInput` fields table (from shared schema — copy the field list), attachments, tags, `scheduledAt`, idempotency, tracking, suppressions, SMTP relay (host/port/credentials).
- `api-keys`: full vs sending-only, domain scoping, rotation.
- `webhooks`: event list (`WEBHOOK_EVENT_TYPES`), payload shape, signature verification (`sendsprite/next` sample + raw HMAC sample), retries, disabled reasons.
- `sdk`: install, construct, every namespace with a snippet, `iterate`, `stream`, `sendsprite/react` example (`renderEmail` and `send({ react })`), errors (`SendspriteError` fields), retries.
- `cli`: each command with example output.
- `mcp`: Claude Desktop / Claude Code config JSON for stdio, `--http` mode, tool list with one-line descriptions.

- [ ] **Step 4: API reference**

`docs/api/route.ts`:

```ts
import { ApiReference } from "@scalar/nextjs-api-reference";
export const dynamic = "force-dynamic";
export const GET = ApiReference({
  url: "/api/v1/openapi.json",
  theme: "kepler",
  darkMode: true,
  hideDarkModeToggle: true,
  metaData: { title: "Sendsprite API reference" },
});
```

(Check the 0.11 option names in `node_modules/@scalar/nextjs-api-reference/dist/index.d.ts`; the `url` of the spec is the only required one.) Add `@scalar/*` to `serverExternalPackages` if Turbopack complains.

- [ ] **Step 5: e2e**

`apps/web/tests/e2e/docs.spec.ts`:

```ts
import { expect, test } from "@playwright/test";
test("docs pages and API reference render", async ({ page }) => {
  await page.goto("/docs");
  await expect(
    page.getByRole("heading", { level: 1, name: /getting started/i }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Webhooks" }).click();
  await expect(page.getByText("sendsprite-signature")).toBeVisible();
  await page.goto("/docs/api");
  await expect(
    page.getByText("Sendsprite API", { exact: false }).first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText("sendEmail").or(page.getByText("Send an email")).first(),
  ).toBeVisible({ timeout: 20_000 });
  const spec = await page.request.get("/api/v1/openapi.json");
  expect(spec.ok()).toBe(true);
  expect((await spec.json()).openapi).toBe("3.1.0");
});
```

- [ ] **Step 6: Run and commit**

Run: `cd apps/web && bun run build && bun run test:e2e` (the Playwright config boots the server), then root checks.

```bash
git add apps/web bun.lock
git commit -m "feat(web): /docs MDX site and Scalar API reference at /docs/api"
```

---

## Task 12: Landing page

**Files:**

- Create: `apps/web/src/components/landing/{Hero,FeatureGrid,CodeTabs,Steps,Footer}.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Test: `apps/web/tests/e2e/landing.spec.ts`

- [ ] **Step 1: Write the failing e2e**

```ts
import { expect, test } from "@playwright/test";
test("landing page (LANDING_ENABLED) shows hero, install and docs links", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    /email api/i,
  );
  await expect(page.getByText("curl -fsSL")).toBeVisible();
  await page.getByRole("tab", { name: "React" }).click();
  await expect(page.getByText("sendsprite/react")).toBeVisible();
  await expect(
    page.getByRole("link", { name: /read the docs/i }),
  ).toHaveAttribute("href", "/docs");
  await expect(
    page.getByRole("link", { name: /open dashboard|sign in/i }),
  ).toBeVisible();
});
```

- [ ] **Step 2: Build the page** (theme rules from `site_v2`/aws-cost-dashboard: ink background, `grid-hairlines` section backdrop, `num-stamp` eyebrow labels, `metric-xl` display headings, `hairline` separators, indigo accent, `rise-in` on hero entrance, generous whitespace, no stock illustrations):

- `Hero`: eyebrow `01 — Self-hosted`, h1 "The email API you run yourself.", sub "Amazon SES under the hood. One container, one command. Your domains, your data.", CTAs `Open dashboard` (`/app`) + `Read the docs` (`/docs`), install block `curl -fsSL https://raw.githubusercontent.com/defy-works/sendsprite/main/install.sh | bash` with copy button (client component).
- `CodeTabs` (client): tabs `curl`, `Node`, `React`, `CLI` — accurate snippets (`Sendsprite` constructor, `emails.send`, `renderEmail`, `npx sendsprite emails send …`); `role="tablist"`/`role="tab"`.
- `FeatureGrid`: six cards: SES auto-setup (CloudFormation), Cloudflare DNS, webhooks & SSE, suppressions & reputation guardrails, SMTP relay, MCP server — each `outlined` card with an eyebrow number.
- `Steps`: 1 install, 2 connect AWS (one click), 3 add domain, 4 send.
- `Footer`: MIT, GitHub `https://github.com/defy-works/sendsprite`, docs, "Built by Defy Works" (`https://defy.works`).
- Keep the existing `landingEnabled` redirect logic at the top of `page.tsx`; `metadata` title "Sendsprite — self-hosted email API".

- [ ] **Step 3: Run, commit**

Run: `cd apps/web && bun run test:e2e`, then root checks.

```bash
git add apps/web
git commit -m "feat(web): landing page"
```

---

## Task 13: Publishing — changesets, release workflow, CI/Docker updates

**Files:**

- Create: `.changeset/config.json`, `.changeset/README.md`, `.changeset/initial-sdk.md`, `.github/workflows/release.yml`, `packages/sdk/scripts/sync-version.ts`
- Modify: root `package.json`, `.github/workflows/ci.yml`, `Dockerfile`, `README.md`

- [ ] **Step 1: Changesets**

`bun add -d @changesets/cli` at root; `.changeset/config.json`: `{ "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json", "changelog": "@changesets/cli/changelog", "commit": false, "access": "public", "baseBranch": "main", "ignore": ["@sendsprite/web", "@sendsprite/shared"], "updateInternalDependencies": "patch" }`. Root scripts: `"changeset": "changeset"`, `"version-packages": "changeset version && bun run --filter sendsprite sync-version && bun install --lockfile-only"`, `"release": "bun run --filter sendsprite build && bun run --filter @sendsprite/mcp build && changeset publish"`. `sync-version.ts` rewrites `SDK_VERSION` in `packages/sdk/src/client.ts` from `package.json` (and `MCP_VERSION` in `packages/mcp/src/server.ts`); wire `"sync-version": "bun run scripts/sync-version.ts"` and a test in `packages/sdk/tests/version.test.ts` asserting `SDK_VERSION === require("../package.json").version`. Initial changeset: `sendsprite: minor`, `@sendsprite/mcp: minor` — "Initial release".

- [ ] **Step 2: Release workflow**

`.github/workflows/release.yml` — on push to `main`: checkout, `oven-sh/setup-bun@v2`, `bun install --frozen-lockfile`, `changesets/action@v1` with `version: bun run version-packages`, `publish: bun run release`, `env: NPM_TOKEN: ${{ secrets.NPM_TOKEN }}`, `GITHUB_TOKEN`; write `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` to `~/.npmrc` before publish (`npm config set` step). Note in `README.md` → "Releasing": set the `NPM_TOKEN` repo secret; the token shared in chat is **not** committed anywhere and should be rotated after the first publish.

- [ ] **Step 3: CI + Docker**

`ci.yml` test job: add `bun run --filter sendsprite build && bun run --filter @sendsprite/mcp build` and a "pack check" step `cd packages/sdk && npm pack --dry-run` (fails if `files`/exports are wrong). `Dockerfile` deps layer: `COPY packages/sdk/package.json packages/sdk/` and `COPY packages/mcp/package.json packages/mcp/` (bun's frozen install needs every workspace manifest). `.dockerignore`: add `packages/*/dist`.

- [ ] **Step 4: Verify locally**

Run: `bun install && bun run typecheck && bun run lint && bun run format && bun run test && cd packages/sdk && npm pack --dry-run && cd ../mcp && npm pack --dry-run`
Expected: pack lists only `dist/**`, `README.md`, `package.json`.

```bash
git add -A
git commit -m "chore: changesets release pipeline; CI builds and pack-checks the packages; Dockerfile copies package manifests"
```

---

## Task 14: End-to-end — SDK + CLI + MCP against the running server; docs/README; tag

**Files:**

- Create: `apps/web/tests/e2e/sdk.spec.ts`
- Modify: `README.md`, `docs/superpowers/plans/2026-08-25-phase-4-developer-surface.md` (status block), memory notes

- [ ] **Step 1: e2e through the real packages**

`apps/web/tests/e2e/sdk.spec.ts` (Playwright `request`-free; drives the built `sendsprite` dist and the MCP server in-process):

```ts
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { Sendsprite } from "../../../../packages/sdk/dist/index.js";
import { createServer } from "../../../../packages/mcp/dist/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Reuses the account/domain from setup.spec.ts through the UI-created API key:
// setup.spec.ts stores the key secret in process.env.E2E_API_KEY (add that to setup.spec.ts:
// create a full key on Settings → API keys and export its shown secret).
const base = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3001";

test("SDK: me, domains.list, emails.send + get, stream sees the change", async () => {
  const c = new Sendsprite({ apiKey: process.env.E2E_API_KEY!, baseUrl: base });
  const me = await c.me();
  expect(me.apiKey.permission).toBe("full");
  const domains = await c.domains.list();
  const verified = domains.data.find((d) => d.status === "verified");
  expect(verified, "send.spec.ts verifies a domain first").toBeTruthy();
  const seen: string[] = [];
  const s = c.stream({
    onChange: (e) => {
      if (e.type === "email" && e.id) seen.push(e.id);
    },
    reconnect: false,
  });
  const { id } = await c.emails.send({
    from: `hi@${verified!.name}`,
    to: "dest@example.com",
    subject: "sdk e2e",
    text: "hello",
  });
  await expect
    .poll(async () => (await c.emails.get(id)).status, { timeout: 30_000 })
    .toBe("sent");
  await expect.poll(() => seen.includes(id), { timeout: 10_000 }).toBe(true);
  s.close();
});

test("CLI: whoami and emails send via env credentials", async () => {
  const env = {
    ...process.env,
    SENDSPRITE_URL: base,
    SENDSPRITE_API_KEY: process.env.E2E_API_KEY!,
    SENDSPRITE_CONFIG_DIR: test.info().outputPath("cfg"),
  };
  const cli = "../../packages/sdk/dist/cli.js";
  expect(
    execFileSync("node", [cli, "whoami"], { env, encoding: "utf8" }),
  ).toMatch(/full/);
  const out = execFileSync("node", [cli, "domains", "list", "--json"], {
    env,
    encoding: "utf8",
  });
  const verified = JSON.parse(out).find(
    (d: { status: string }) => d.status === "verified",
  );
  expect(
    execFileSync(
      "node",
      [
        cli,
        "emails",
        "send",
        "--from",
        `hi@${verified.name}`,
        "--to",
        "dest@example.com",
        "--subject",
        "cli e2e",
        "--text",
        "hi",
      ],
      { env, encoding: "utf8" },
    ),
  ).toMatch(/Queued em_/);
});

test("MCP: list_domains and get_send_stats through the real SDK", async () => {
  const server = createServer(
    new Sendsprite({ apiKey: process.env.E2E_API_KEY!, baseUrl: base }),
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(b);
  const r = await client.callTool({ name: "get_send_stats", arguments: {} });
  expect(r.isError).toBeFalsy();
  expect(
    (r.structuredContent as { sent: { today: number } }).sent.today,
  ).toBeGreaterThan(0);
});
```

Adjust `setup.spec.ts` to create the API key and write it to a file under `test.info().project.outputDir` (`e2e-api-key.txt`) — env vars don't cross Playwright workers; read the file in `sdk.spec.ts`. Playwright config: add `sdk.spec.ts` to the `app` project after `send.spec.ts` (`fullyParallel: false` is already how the project runs — verify). The `test:e2e` script must build the packages first: `"test:e2e": "bun run --filter sendsprite build && bun run --filter @sendsprite/mcp build && playwright test"`.

- [ ] **Step 2: Run the whole thing**

Run: `bun run typecheck && bun run lint && bun run format:check && bun run test && bun run test:integration && bun run test:e2e`
Expected: green. Record counts.

- [ ] **Step 3: README + plan status + memory**

README: sections "Install (self-host)", "Send your first email" (curl + SDK), "Packages" (`sendsprite`, `@sendsprite/mcp` with install lines), "Docs" link, "Releasing". Append a "Phase 4 status: COMPLETE" block to this plan listing what shipped, test counts, and "Phase 5 openers" (templates + `templates pull/push` + MCP `list_templates`/`render_template`/`add_contact`, contacts/audiences, audit log UI, anything reviewers flagged). Update memory `sendsprite-project.md`.

- [ ] **Step 4: Commit and tag**

```bash
git add -A
git commit -m "test(e2e): SDK, CLI and MCP against the running server; README and Phase 4 status"
git tag phase-4-complete
```

---

## Self-review

**Spec coverage (§9/§10 + openers):**

- `sendsprite` ESM+CJS, namespaces, typed errors, retry on 429/5xx → Tasks 5–6. ✔
- `sendsprite/react` primitives + `renderEmail`, `send({ react })` → Task 7. ✔
- `sendsprite/next` `createWebhookHandler`, `verifyWebhook` → Task 8. ✔
- CLI `login, whoami, domains list, emails send, emails tail` → Task 9 (needs API-key SSE → Task 3). `templates pull|push` → Phase 5 (stated). ✔
- `@sendsprite/mcp` stdio + streamable HTTP; tools minus templates/contacts (Phase 5, stated) → Task 10. ✔
- OpenAPI 3.1 at `/api/v1/openapi.json`, rendered at `/docs/api` → Tasks 4, 11. ✔
- `/docs` MDX → Task 11. Landing at `/` with `LANDING_ENABLED` → Task 12. ✔
- Openers: shared consumability (adapted, rationale stated) + node entry + shared contracts + `EmailEventObject.type` enum + `PatchEmailInput` → Task 1; Result `code` unification + `serviceFailure()` + cursor pagination → Task 2; API-key SSE → Task 3; SDK retry → Task 5. Not in this phase (still open, non-blocking): `worker.ts`/`WORKER_MODE=separate`, sweep granularity, SMTP PROXY protocol, audit rows for cancel/resend/reschedule, REST audit ip/UA, `email_events` PII purge, body caps on non-email routes, SNS Timestamp freshness, `batchSize`/`localConcurrency`, shutdown timeout alignment, `domain.provision` singletonKey — carried to the Phase 5 openers list.
- Publishing with `NPM_TOKEN` via changesets → Task 13. ✔

**Placeholder scan:** Snippets that say "same shape as X" name the exact function to copy (`listEmails`, `Emails` class) and list every method; docs page bullets enumerate the content. `apps/web/tests/integration/helpers` `seedTeamWithKey` is named as "create if none exists" with its contract (`{ team, key, secret }`, `{ permission }` option) implied by the tests — implementer must read an existing rest integration test to match the setup style.

**Type consistency:** `Page<T> = { data, nextCursor: string | null }` everywhere; `StreamChange` reused by SSE test, SDK `stream`, CLI tail; `SendspriteError.code` = `ErrorCode | "network_error"`; `HttpClient.request(method, path, { body, query, retry, signal })` used identically in Tasks 5, 6, 9; `createServer(client)` used in Tasks 10 and 14; `buildOpenApiDocument({ serverUrl, version })` in Tasks 4 and 11.
