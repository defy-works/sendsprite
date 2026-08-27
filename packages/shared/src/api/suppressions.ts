import { z } from "zod";

export const SUPPRESSION_REASONS = [
  "bounce",
  "complaint",
  "manual",
  "unsubscribe",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * Bounce/complaint entries come only from SES events; the API adds
 * manual/unsubscribe. Must stay `z.toJSONSchema`-representable (no
 * transforms): an empty form value for `note` is normalised to "unset" by
 * the dashboard action that submits it, not here.
 */
export const AddSuppressionInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email.")),
  reason: z.enum(["manual", "unsubscribe"]).default("manual"),
  note: z.string().trim().min(1).max(500, "Note is too long.").optional(),
});
export type AddSuppressionInput = z.infer<typeof AddSuppressionInput>;

export const SuppressionObject = z.object({
  id: z.string(),
  email: z.string(),
  reason: z.enum(SUPPRESSION_REASONS),
  note: z.string().nullable(),
  sourceEmailId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type SuppressionObject = z.infer<typeof SuppressionObject>;
