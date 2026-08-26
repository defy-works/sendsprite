import { z } from "zod";

export const API_KEY_PERMISSIONS = ["full", "sending_only"] as const;
export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

/**
 * Must stay `z.toJSONSchema`-representable (it feeds the OpenAPI document):
 * no transforms. An empty form value for `domainId` is normalised to
 * "unset" by the dashboard action that submits it, not here.
 */
export const CreateApiKeyInput = z.object({
  name: z.string().trim().min(1, "Name is required.").max(64),
  permission: z.enum(API_KEY_PERMISSIONS).default("full"),
  domainId: z.string().trim().min(1).optional(),
});
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyInput>;

export const ApiKeyObject = z.object({
  id: z.string(),
  name: z.string(),
  permission: z.enum(API_KEY_PERMISSIONS),
  keyPrefix: z.string(),
  domainId: z.string().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ApiKeyObject = z.infer<typeof ApiKeyObject>;

/** Returned once, by `POST /api-keys`. */
export const ApiKeyCreated = z.object({ id: z.string(), secret: z.string() });
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;
