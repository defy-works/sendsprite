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
  required?: string[];
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
  requestBody?: { required: true; content: Record<string, MediaTypeObject> };
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
  SendStatsObject,
  MeObject,
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
      rest as JsonSchema,
    ]),
  );
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
  ...(description && { description }),
  schema: { type: "string" },
});
const body = (name: SchemaId): Operation["requestBody"] => ({
  required: true,
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
          "`text/event-stream` of `event: change` messages whose `data` is a `StreamChange` (`{ type, id }`), emitted when an email or webhook delivery changes. Full keys only.",
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
        "Self-hosted email API on Amazon SES. Authenticate every request with `Authorization: Bearer ss_live_…`. Errors share one envelope: `{ error: { code, message, details? } }`.",
    },
    servers: [{ url: `${opts.serverUrl.replace(/\/+$/, "")}/api/v1` }],
    security: [{ apiKey: [] }],
    tags: [
      { name: "Emails" },
      { name: "Domains" },
      { name: "API keys" },
      { name: "Webhooks" },
      { name: "Suppressions" },
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
