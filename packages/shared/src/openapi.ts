import { z } from "zod";
import { ERROR_CODES, HTTP_STATUS, type ErrorCode } from "./api/errors";
import {
  BatchSendInput,
  EMAIL_STATUS,
  EmailDetail,
  EmailEventObject,
  EmailObject,
  PatchEmailInput,
  SendEmailInput,
  pageOf,
} from "./api/emails";
import {
  CreateDomainInput,
  DnsRecordObject,
  DomainObject,
} from "./api/domains";
import { ApiKeyCreated, ApiKeyObject, CreateApiKeyInput } from "./api/api-keys";
import {
  CreateWebhookInput,
  UpdateWebhookInput,
  WebhookCreated,
  WebhookObject,
  WebhookTestAccepted,
} from "./api/webhook-objects";
import { AddSuppressionInput, SuppressionObject } from "./api/suppressions";
import {
  CreateTemplateInput,
  RenderTemplateInput,
  RenderedTemplateObject,
  TemplateDetail,
  TemplateObject,
  TemplateVersionObject,
  UpdateTemplateInput,
} from "./api/templates";
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
import {
  AudiencePreview,
  CAMPAIGN_STATUSES,
  CampaignObject,
  CreateCampaignInput,
  ScheduleCampaignInput,
  UpdateCampaignInput,
} from "./api/campaigns";
import { SendStatsObject } from "./api/stats";
import { MeObject } from "./api/me";
import { StreamChange } from "./api/stream";

/**
 * OpenAPI 3.1 document for `/api/v1`, derived from the shared zod contracts
 * so the SDK, the MCP tools and the reference docs all describe the same
 * objects. Pure: no I/O, no server imports. Schemas are emitted by
 * `z.toJSONSchema` in two passes — request bodies as their *input* shape
 * (what a client sends: defaults optional, unions before transforms) and
 * response objects as their *output* shape — and every registered schema
 * becomes a `#/components/schemas/<Id>` reference.
 *
 * Status codes are hand-listed per operation and must match what the route
 * (and the services it calls) actually return; the web app's coverage test
 * only guarantees that every route file has an entry here.
 */

/** Enough of JSON Schema 2020-12 for callers to navigate the output. */
export interface JsonSchema {
  [key: string]: unknown;
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  allOf?: JsonSchema[];
  description?: string;
  default?: unknown;
}
export interface MediaTypeObject {
  schema: JsonSchema;
}
export interface ResponseObject {
  description: string;
  content?: Record<string, MediaTypeObject>;
}
export interface ParameterObject {
  name: string;
  in: "query" | "path";
  required?: boolean;
  description?: string;
  schema: JsonSchema;
}
export interface Operation {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters?: ParameterObject[];
  requestBody?: { required: boolean; content: Record<string, MediaTypeObject> };
  responses: Record<string, ResponseObject>;
}

const ApiError = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/** Request bodies: emitted with `io: "input"`. */
const inputSchemas = {
  SendEmailInput,
  BatchSendInput,
  PatchEmailInput,
  CreateDomainInput,
  CreateApiKeyInput,
  CreateWebhookInput,
  UpdateWebhookInput,
  AddSuppressionInput,
  CreateTemplateInput,
  UpdateTemplateInput,
  RenderTemplateInput,
  CreateContactBookInput,
  UpdateContactBookInput,
  CreateContactInput,
  UpdateContactInput,
  ImportContactsInput,
  UnsubscribeContactInput,
  CreateCampaignInput,
  UpdateCampaignInput,
  ScheduleCampaignInput,
};
/** Response bodies: emitted with `io: "output"`. */
const outputSchemas = {
  ApiError,
  EmailObject,
  EmailEventObject,
  EmailDetail,
  EmailPage: pageOf(EmailObject),
  DnsRecordObject,
  DomainObject,
  DomainPage: pageOf(DomainObject),
  ApiKeyObject,
  ApiKeyCreated,
  ApiKeyPage: pageOf(ApiKeyObject),
  WebhookObject,
  WebhookCreated,
  WebhookTestAccepted,
  WebhookPage: pageOf(WebhookObject),
  SuppressionObject,
  SuppressionPage: pageOf(SuppressionObject),
  TemplateObject,
  TemplateVersionObject,
  TemplateDetail,
  TemplatePage: pageOf(TemplateObject),
  RenderedTemplateObject,
  ContactBookObject,
  ContactBookPage: pageOf(ContactBookObject),
  ContactObject,
  ContactPage: pageOf(ContactObject),
  ImportContactsResult,
  UnsubscribeResult,
  CampaignObject,
  CampaignPage: pageOf(CampaignObject),
  AudiencePreview,
  SendStatsObject,
  MeObject,
  // Registered only so `/stream`'s description can name it; no operation refers to it.
  StreamChange,
};
export type SchemaId = keyof typeof inputSchemas | keyof typeof outputSchemas;

const uri = (id: string) => `#/components/schemas/${id}`;

function emit(
  schemas: Record<string, z.ZodType>,
  io: "input" | "output",
): Record<string, JsonSchema> {
  const registry = z.registry<{ id: string }>();
  for (const [id, s] of Object.entries(schemas)) registry.add(s, { id });
  const { schemas: out } = z.toJSONSchema(registry, {
    uri,
    unrepresentable: "any",
    io,
  });
  // Each entry carries `$schema` and a fragment-only `$id`; neither belongs
  // under `components.schemas` (an `$id` there would re-base sibling refs).
  return Object.fromEntries(
    Object.entries(out).map(([id, { $schema: _s, $id: _i, ...rest }]) => [
      id,
      tidy(rest as JsonSchema, io),
    ]),
  );
}

/**
 * Post-process one emitted tree. Responses are not validated at runtime, so
 * the `additionalProperties: false` zod puts on output objects is dropped:
 * a closed shape would make every additive field a breaking change for
 * strict generators. `z.iso.datetime()` also emits a long `pattern` next
 * to `format: "date-time"`; the format says it all, so the pattern goes
 * (other patterns, e.g. the address checks on `SendEmailInput`, stay).
 */
function tidy(node: JsonSchema, io: "input" | "output"): JsonSchema {
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    if (io === "output" && k === "additionalProperties" && v === false)
      continue;
    if (k === "pattern" && node.format === "date-time") continue;
    out[k] = walk(v, io);
  }
  return out;
}
function walk(v: unknown, io: "input" | "output"): unknown {
  if (Array.isArray(v)) return v.map((x) => walk(x, io));
  if (v && typeof v === "object") return tidy(v as JsonSchema, io);
  return v;
}

const ref = (name: SchemaId): JsonSchema => ({ $ref: uri(name) });
const json = (schema: JsonSchema, description: string): ResponseObject => ({
  description,
  content: { "application/json": { schema } },
});
const idOnly: JsonSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};

/** Every route goes through `withApiKey`: bad key, wrong permission, or a thrown error. */
const common: ErrorCode[] = ["unauthorized", "forbidden", "internal_error"];
/** `/me` accepts any key, so it can never be `forbidden`. */
const anyKey: ErrorCode[] = ["unauthorized", "internal_error"];

/** One `ApiError` response per distinct HTTP status, described by its codes. */
const errors = (...codes: ErrorCode[]): Record<string, ResponseObject> =>
  Object.fromEntries(
    [...new Set(codes.map((c) => HTTP_STATUS[c]))]
      .sort((a, b) => a - b)
      .map((s) => [
        String(s),
        json(
          ref("ApiError"),
          [...new Set(codes.filter((c) => HTTP_STATUS[c] === s))].join(" | "),
        ),
      ]),
  );

const pageParams: ParameterObject[] = [
  {
    name: "limit",
    in: "query",
    description: "Page size.",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
  },
  {
    name: "cursor",
    in: "query",
    description: "`nextCursor` from the previous page.",
    schema: { type: "string" },
  },
];
const idParam = (name = "id", description?: string): ParameterObject => ({
  name,
  in: "path",
  required: true,
  ...(description ? { description } : {}),
  schema: { type: "string" },
});
const body = (name: SchemaId): Operation["requestBody"] => ({
  required: true,
  content: { "application/json": { schema: ref(name) } },
});
/**
 * A body the caller may leave off entirely.
 *
 * Only `POST /campaigns/{id}/schedule` uses it, and the distinction is not
 * cosmetic: an omitted body there *is* the "start now" request, so marking it
 * `required` would make every generated client demand a payload for the most
 * common call on the endpoint.
 */
const optionalBody = (name: SchemaId): Operation["requestBody"] => ({
  required: false,
  content: { "application/json": { schema: ref(name) } },
});
const op = (
  tag: string,
  operationId: string,
  summary: string,
  rest: Omit<Operation, "operationId" | "summary" | "tags">,
): Operation => ({ operationId, summary, tags: [tag], ...rest });

export interface OpenApiOptions {
  /** Public base URL of the instance (`APP_URL`); `/api/v1` is appended. */
  serverUrl: string;
  /** `info.version`; the running build's version, or `"dev"`. */
  version?: string;
}

export function buildOpenApiDocument(opts: OpenApiOptions) {
  const schemas = {
    ...emit(inputSchemas, "input"),
    ...emit(outputSchemas, "output"),
  } as Record<SchemaId, JsonSchema>;

  const paths = {
    "/emails": {
      post: op("Emails", "sendEmail", "Send an email", {
        description:
          "Queues one email. `201 { id }`; a replayed `idempotencyKey` returns `200` with the earlier id. Sending-only keys may call this. Responses carry `x-ratelimit-*` headers.",
        requestBody: body("SendEmailInput"),
        responses: {
          "201": json(idOnly, "Queued"),
          "200": json(idOnly, "Idempotent replay of an earlier send"),
          ...errors(
            ...common,
            "validation_error",
            "idempotency_conflict",
            "domain_not_verified",
            "suppressed_recipient",
            "daily_quota_exceeded",
            "monthly_quota_exceeded",
            "payload_too_large",
          ),
        },
      }),
      get: op("Emails", "listEmails", "List emails", {
        description: "Newest first. `nextCursor` is null on the last page.",
        parameters: [
          ...pageParams,
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: EMAIL_STATUS },
          },
          {
            name: "to",
            in: "query",
            description: "Exact recipient address.",
            schema: { type: "string" },
          },
          { name: "domainId", in: "query", schema: { type: "string" } },
          {
            name: "tag",
            in: "query",
            description: "`key:value`, or a bare key to match any value.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": json(ref("EmailPage"), "Page of emails"),
          ...errors(...common, "validation_error"),
        },
      }),
    },
    "/emails/batch": {
      post: op("Emails", "sendBatch", "Send up to 100 emails", {
        description:
          "Items are created in order; on the first refusal the error carries `details.index` and the earlier items stay queued. Sending-only keys may call this.",
        requestBody: body("BatchSendInput"),
        responses: {
          "201": json(
            {
              type: "object",
              properties: { data: { type: "array", items: idOnly } },
              required: ["data"],
            },
            "Queued",
          ),
          ...errors(
            ...common,
            "validation_error",
            "idempotency_conflict",
            "domain_not_verified",
            "suppressed_recipient",
            "daily_quota_exceeded",
            "monthly_quota_exceeded",
            "payload_too_large",
          ),
        },
      }),
    },
    "/emails/{id}": {
      get: op("Emails", "getEmail", "Get an email and its events", {
        parameters: [idParam()],
        responses: {
          "200": json(ref("EmailDetail"), "Email with its timeline"),
          ...errors(...common, "not_found"),
        },
      }),
      patch: op("Emails", "rescheduleEmail", "Move a scheduled email", {
        description:
          "Only `scheduled` emails can be moved, and only to a future time.",
        parameters: [idParam()],
        requestBody: body("PatchEmailInput"),
        responses: {
          "200": json(ref("EmailObject"), "Updated email"),
          ...errors(...common, "validation_error", "not_found", "conflict"),
        },
      }),
    },
    "/emails/{id}/cancel": {
      post: op("Emails", "cancelEmail", "Cancel a queued or scheduled email", {
        parameters: [idParam()],
        responses: {
          "200": json(ref("EmailObject"), "Cancelled email"),
          ...errors(...common, "not_found", "conflict"),
        },
      }),
    },
    "/domains": {
      get: op("Domains", "listDomains", "List domains", {
        parameters: pageParams,
        responses: {
          "200": json(ref("DomainPage"), "Page of domains"),
          ...errors(...common, "validation_error"),
        },
      }),
      post: op("Domains", "createDomain", "Add a sending domain", {
        description:
          "Provisioning runs in the background; poll `GET /domains/{id}` for the DNS records and status. `503` until AWS is connected.",
        requestBody: body("CreateDomainInput"),
        responses: {
          "201": json(ref("DomainObject"), "Domain"),
          ...errors(
            ...common,
            "validation_error",
            "conflict",
            "not_configured",
          ),
        },
      }),
    },
    "/domains/{id}": {
      get: op("Domains", "getDomain", "Get a domain", {
        parameters: [idParam()],
        responses: {
          "200": json(ref("DomainObject"), "Domain"),
          ...errors(...common, "not_found"),
        },
      }),
      delete: op("Domains", "deleteDomain", "Delete a domain", {
        description:
          "Removes the SES identity and the DNS records Sendsprite created, then the domain.",
        parameters: [idParam()],
        responses: {
          "204": { description: "Deleted" },
          "200": json(
            {
              type: "object",
              properties: {
                leftoverDnsRecords: {
                  type: "integer",
                  description:
                    "Cloudflare records that could not be removed and need cleaning up by hand.",
                },
              },
              required: ["leftoverDnsRecords"],
            },
            "Deleted; some DNS records need manual cleanup",
          ),
          ...errors(...common, "not_found"),
        },
      }),
    },
    "/domains/{id}/verify": {
      post: op("Domains", "verifyDomain", "Run a verification check now", {
        description:
          "`409` while provisioning has not finished. Returns the updated domain.",
        parameters: [idParam()],
        responses: {
          "200": json(ref("DomainObject"), "Domain after the check"),
          ...errors(...common, "not_found", "conflict"),
        },
      }),
    },
    "/api-keys": {
      get: op("API keys", "listApiKeys", "List API keys", {
        parameters: pageParams,
        responses: {
          "200": json(ref("ApiKeyPage"), "Page of API keys"),
          ...errors(...common, "validation_error"),
        },
      }),
      post: op("API keys", "createApiKey", "Create an API key", {
        requestBody: body("CreateApiKeyInput"),
        responses: {
          "201": json(
            ref("ApiKeyCreated"),
            "Created — the secret is returned only here",
          ),
          ...errors(...common, "validation_error"),
        },
      }),
    },
    "/api-keys/{id}": {
      delete: op("API keys", "revokeApiKey", "Revoke an API key", {
        parameters: [idParam()],
        responses: {
          "204": { description: "Revoked" },
          ...errors(...common, "not_found"),
        },
      }),
    },
    "/webhooks": {
      get: op("Webhooks", "listWebhooks", "List webhooks", {
        parameters: pageParams,
        responses: {
          "200": json(ref("WebhookPage"), "Page of webhooks"),
          ...errors(...common, "validation_error"),
        },
      }),
      post: op("Webhooks", "createWebhook", "Create a webhook", {
        requestBody: body("CreateWebhookInput"),
        responses: {
          "201": json(
            ref("WebhookCreated"),
            "Created — the signing secret is returned only here",
          ),
          ...errors(...common, "validation_error"),
        },
      }),
    },
    "/webhooks/{id}": {
      patch: op("Webhooks", "updateWebhook", "Update a webhook", {
        parameters: [idParam()],
        requestBody: body("UpdateWebhookInput"),
        responses: {
          "200": json(ref("WebhookObject"), "Updated webhook"),
          ...errors(...common, "validation_error", "not_found"),
        },
      }),
      delete: op("Webhooks", "deleteWebhook", "Delete a webhook", {
        parameters: [idParam()],
        responses: {
          "204": { description: "Deleted" },
          ...errors(...common, "not_found"),
        },
      }),
    },
    "/webhooks/{id}/test": {
      post: op("Webhooks", "testWebhook", "Send a test event", {
        description:
          "Queues a synthetic `email.delivered` delivery. `409` when the webhook is disabled.",
        parameters: [idParam()],
        responses: {
          "202": json(ref("WebhookTestAccepted"), "Delivery queued"),
          ...errors(...common, "not_found", "conflict"),
        },
      }),
    },
    "/suppressions": {
      get: op("Suppressions", "listSuppressions", "List suppressed addresses", {
        parameters: pageParams,
        responses: {
          "200": json(ref("SuppressionPage"), "Page of suppressions"),
          ...errors(...common, "validation_error"),
        },
      }),
      post: op("Suppressions", "addSuppression", "Suppress an address", {
        description:
          "Also `201` for an address that is already listed (the existing row is returned).",
        requestBody: body("AddSuppressionInput"),
        responses: {
          "201": json(ref("SuppressionObject"), "Suppression"),
          ...errors(...common, "validation_error"),
        },
      }),
    },
    "/suppressions/{email}": {
      delete: op("Suppressions", "removeSuppression", "Unsuppress an address", {
        parameters: [idParam("email", "Percent-encoded address.")],
        responses: {
          "204": { description: "Removed" },
          ...errors(...common, "validation_error", "not_found"),
        },
      }),
    },
    "/templates": {
      get: op("Templates", "listTemplates", "List templates", {
        description:
          "Newest first. Full keys only, like every templates route.",
        parameters: pageParams,
        responses: {
          "200": json(ref("TemplatePage"), "Page of templates"),
          ...errors(...common, "validation_error"),
        },
      }),
      post: op("Templates", "createTemplate", "Create a template", {
        description:
          "`slug` is the name `POST /emails` uses in `template`, and is unique per team. Bodies use `{{ variable }}` placeholders; values are HTML-escaped into `bodyHtml` and left raw in `bodyText`. A placeholder with no value and no declared `default` is a refusal at render time, not an empty string.",
        requestBody: body("CreateTemplateInput"),
        responses: {
          "201": json(ref("TemplateObject"), "Template, at version 1"),
          ...errors(...common, "validation_error", "conflict"),
        },
      }),
    },
    "/templates/{slug}": {
      get: op("Templates", "getTemplate", "Get a template and its versions", {
        description: "The path segment accepts the slug or the `tpl_…` id.",
        parameters: [idParam("slug", "Template slug, or its id.")],
        responses: {
          "200": json(
            ref("TemplateDetail"),
            "Template with its version history",
          ),
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
          "A dry run: nothing is sent or stored, and the output is byte-identical to what `POST /emails` would store for the same variables. A missing or non-scalar variable is a `400` listing it in `details.missing` / `details.invalid`. This route carries its own 256 KB body cap, since a `variables` payload is capped at 64 KB serialised.",
        parameters: [idParam("slug", "Template slug, or its id.")],
        requestBody: body("RenderTemplateInput"),
        responses: {
          "200": json(
            ref("RenderedTemplateObject"),
            "Rendered subject and bodies",
          ),
          ...errors(
            ...common,
            "validation_error",
            "not_found",
            "payload_too_large",
          ),
        },
      }),
    },
    "/contact-books": {
      get: op("Contacts", "listContactBooks", "List contact books", {
        description: "Newest first, each with its contact counts.",
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
        description:
          "Newest first. `q` matches an address prefix or either name.",
        parameters: [
          idParam(),
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
          "The CSV needs an `email` column; `first_name`, `last_name`, `subscribed` and `unsubscribe_reason` are recognised, `created_at` is ignored, and every other column becomes a property. Up to 2 MB and 10 000 rows per call — import a bigger list in chunks. **Partial success is the normal outcome and answers `200`**: bad rows are counted in `skipped`, listed in `errors` (first 100) and do not fail the import, and duplicate addresses inside one file collapse to the last occurrence. Only a document that cannot be read at all is a `400`. A `subscribed` column is honoured for new contacts; an import never resubscribes an address that opted out, and never writes a suppression.",
        parameters: [idParam()],
        requestBody: body("ImportContactsInput"),
        responses: {
          "200": json(
            ref("ImportContactsResult"),
            "Import counts and per-row errors",
          ),
          ...errors(
            ...common,
            "validation_error",
            "not_found",
            "payload_too_large",
          ),
        },
      }),
    },
    "/contacts/unsubscribe": {
      post: op("Contacts", "unsubscribeContact", "Unsubscribe an address", {
        description:
          "Records consent withdrawal for an address across every book of the team, or one book with `bookId`. Idempotent: an address that is already out answers `200` with `unsubscribed: 0`. **This is not the suppression list**: it does not stop transactional mail — use `POST /suppressions` for that.",
        requestBody: body("UnsubscribeContactInput"),
        responses: {
          "200": json(ref("UnsubscribeResult"), "How many contacts changed"),
          ...errors(...common, "validation_error"),
        },
      }),
    },
    "/campaigns": {
      get: op("Campaigns", "listCampaigns", "List campaigns", {
        description:
          "Newest first, optionally filtered by `status`. Every campaigns route needs a full key: a sending-only key that could reach this surface could mail the team's whole contact book.",
        parameters: [
          ...pageParams,
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: CAMPAIGN_STATUSES },
          },
        ],
        responses: {
          "200": json(ref("CampaignPage"), "Page of campaigns"),
          ...errors(...common, "validation_error"),
        },
      }),
      post: op("Campaigns", "createCampaign", "Create a campaign", {
        description:
          "Creates a `draft`; nothing is scheduled or sent until `POST /campaigns/{id}/schedule`. The body is a typed block list, not free HTML — the renderer escapes every value it interpolates and URLs are limited to `http:`, `https:` and `mailto:`. `bookId` and `domainId` must belong to the calling team and the domain must be verified, or the field is named in the refusal.",
        requestBody: body("CreateCampaignInput"),
        responses: {
          "201": json(ref("CampaignObject"), "Campaign, as a draft"),
          ...errors(...common, "validation_error", "domain_not_verified"),
        },
      }),
    },
    "/campaigns/{id}": {
      get: op("Campaigns", "getCampaign", "Get a campaign", {
        parameters: [idParam()],
        responses: {
          "200": json(ref("CampaignObject"), "Campaign"),
          ...errors(...common, "not_found"),
        },
      }),
      patch: op("Campaigns", "updateCampaign", "Update a campaign", {
        description:
          "Only a `draft` or `scheduled` campaign can be edited; anything further along is a `409`, because half of a `sending` campaign has already gone out under the old content. Editing a `scheduled` campaign reverts it to `draft` and clears `scheduledAt`, so a change never ships on the old timer — re-arm it explicitly. An update that changes nothing does neither.",
        parameters: [idParam()],
        requestBody: body("UpdateCampaignInput"),
        responses: {
          "200": json(ref("CampaignObject"), "Updated campaign"),
          ...errors(
            ...common,
            "validation_error",
            "not_found",
            "conflict",
            "domain_not_verified",
          ),
        },
      }),
      delete: op("Campaigns", "deleteCampaign", "Delete a campaign", {
        description:
          "Refused with a `409` while the campaign is `sending`; cancel it first. Deleting stops the campaign being listed, it does not erase the send: the `emails` rows it produced keep their bodies, events and `campaignId`.",
        parameters: [idParam()],
        responses: {
          "204": { description: "Deleted" },
          ...errors(...common, "not_found", "conflict"),
        },
      }),
    },
    "/campaigns/{id}/schedule": {
      post: op("Campaigns", "scheduleCampaign", "Schedule a campaign", {
        description:
          "Arms a `draft` or re-arms a `scheduled` campaign. **Send the body empty to start now.** Either way the campaign becomes `scheduled`, never `sending` directly: a background sweep renders the body once and starts the fan-out when the time is due. `scheduledAt` must be an offset-bearing ISO 8601 time in the future — a past time is refused rather than clamped to now, because the mistake that produces one is usually a timezone. The contact book and the domain are re-checked here, however long ago the campaign was written: this is the last moment before mail leaves.",
        parameters: [idParam()],
        requestBody: optionalBody("ScheduleCampaignInput"),
        responses: {
          "200": json(ref("CampaignObject"), "Scheduled campaign"),
          ...errors(
            ...common,
            "validation_error",
            "not_found",
            "conflict",
            "domain_not_verified",
          ),
        },
      }),
    },
    "/campaigns/{id}/cancel": {
      post: op("Campaigns", "cancelCampaign", "Cancel a campaign", {
        description:
          "A `scheduled` campaign is un-armed: it returns to `draft` with `scheduledAt` cleared, and nothing was sent. A `sending` campaign becomes `cancelled`, which **stops further fan-out and nothing more** — recipients already materialised are ordinary emails on the ordinary send path, and mail already handed to SES cannot be recalled. `counts` is therefore left standing and will keep rising for a while as events arrive for messages already in flight. Any other status is a `409`.",
        parameters: [idParam()],
        responses: {
          "200": json(ref("CampaignObject"), "Campaign after the transition"),
          ...errors(...common, "not_found", "conflict"),
        },
      }),
    },
    "/campaigns/{id}/audience": {
      get: op("Campaigns", "getCampaignAudience", "Preview the audience", {
        description:
          "How many contacts the campaign would reach, counted live against its book. The four numbers are four views of one population rather than buckets that sum to it: `eligible` is `subscribed` **and** not `suppressed`, and it is the only one that will be mailed. A campaign whose book has since been deleted answers four zeros.",
        parameters: [idParam()],
        responses: {
          "200": json(ref("AudiencePreview"), "Audience counts"),
          ...errors(...common, "not_found"),
        },
      }),
    },
    "/stats": {
      get: op("Account", "getSendStats", "Sending stats", {
        description: "Send counts, 30-day rates and SES account-health alerts.",
        responses: {
          "200": json(ref("SendStatsObject"), "Stats"),
          ...errors(...common),
        },
      }),
    },
    "/me": {
      get: op("Account", "getMe", "The calling key and its team", {
        description: "Works with any key, including sending-only ones.",
        responses: {
          "200": json(ref("MeObject"), "Caller"),
          ...errors(...anyKey),
        },
      }),
    },
    "/stream": {
      get: op("Account", "streamChanges", "Live change feed (SSE)", {
        description:
          "`text/event-stream` of `event: change` messages whose `data` is a `StreamChange` (`{ type, id? }`), emitted when an email or webhook delivery changes. Full keys only.",
        responses: {
          "200": {
            description: "Event stream",
            content: {
              "text/event-stream": {
                schema: {
                  type: "string",
                  description:
                    "`event: change\\ndata: <StreamChange JSON>\\n\\n` frames.",
                },
              },
            },
          },
          ...errors(...common),
        },
      }),
    },
  } satisfies Record<string, Partial<Record<string, Operation>>>;

  return {
    openapi: "3.1.0" as const,
    info: {
      title: "Sendsprite API",
      version: opts.version ?? "1.0.0",
      description:
        "Self-hosted email API on Amazon SES. Authenticate every request with `Authorization: Bearer ss_live_…`. Errors share one envelope: `{ error: { code, message, details? } }`.\n\n" +
        "**What the dashboard has that this API does not.** A campaign's `theme` (brand colours, fonts, spacing) is part of the contract and may be set here. Reusable *layouts* — a saved header/footer the editor copies into a new campaign — are dashboard-only: a layout is a starting point that is copied in, not a reference the campaign keeps, so the campaign you read back already contains everything a layout contributed and there is nothing further to expose. Uploaded images likewise: the editor stores them and the campaign body references them by URL.",
    },
    servers: [{ url: `${opts.serverUrl.replace(/\/+$/, "")}/api/v1` }],
    security: [{ apiKey: [] }],
    tags: [
      { name: "Emails" },
      { name: "Domains" },
      { name: "API keys" },
      { name: "Webhooks" },
      { name: "Suppressions" },
      { name: "Templates" },
      { name: "Contacts" },
      { name: "Campaigns" },
      { name: "Account" },
    ],
    components: {
      securitySchemes: {
        apiKey: { type: "http" as const, scheme: "bearer" as const },
      },
      schemas,
    },
    paths,
  };
}
export type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
