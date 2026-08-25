import { z } from "zod";

export const SUPPRESSION_REASONS = [
  "bounce",
  "complaint",
  "manual",
  "unsubscribe",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Bounce/complaint entries come only from SES events; the API adds manual/unsubscribe. */
export const AddSuppressionInput = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  reason: z.enum(["manual", "unsubscribe"]).default("manual"),
  // A form's empty input arrives as ""; treat it as unset.
  note: z
    .string()
    .trim()
    .max(500, "Note is too long.")
    .transform((s) => s || undefined)
    .optional(),
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
