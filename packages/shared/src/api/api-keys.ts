import { z } from "zod";

export const API_KEY_PERMISSIONS = ["full", "sending_only"] as const;
export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number];

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
