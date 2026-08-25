import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "./webhooks";

/**
 * Public contract: https only. The server additionally rejects private
 * targets (SSRF) and, outside production, accepts plain http for local
 * listeners — see `apps/web/src/services/webhooks.ts`.
 */
const url = z
  .string()
  .trim()
  .max(2048, "URL is too long.")
  .url()
  .refine((u) => u.startsWith("https://"), "Webhook URLs must use https.");
/** Non-empty subset of `WEBHOOK_EVENT_TYPES`, deduped. */
export const WebhookEvents = z
  .array(z.enum(WEBHOOK_EVENT_TYPES))
  .min(1, "Pick at least one event.")
  .transform((e) => [...new Set(e)]);

export const CreateWebhookInput = z.object({ url, events: WebhookEvents });
export type CreateWebhookInput = z.infer<typeof CreateWebhookInput>;

export const UpdateWebhookInput = z
  .object({ url, events: WebhookEvents, enabled: z.boolean() })
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
export type WebhookTestAccepted = z.infer<typeof WebhookTestAccepted>;
