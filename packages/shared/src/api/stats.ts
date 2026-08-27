import { z } from "zod";

/** `GET /stats`: sends and 30-day rates, plus SES account-health alerts. */
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
