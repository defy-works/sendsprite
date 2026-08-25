import { z } from "zod";

/**
 * Output schemas for the read tools.
 *
 * Every one of these is **loose**: it names the fields the tool promises and
 * emits `additionalProperties: {}`, so a client that gates on the advertised
 * schema still gets structured output, and the day the REST API grows a field
 * nothing throws. A closed schema here would be a forward-compatibility trap —
 * clients validate tool output against it, so an unexpected key is a hard
 * error on their side, not a warning.
 */

/** One item of a list; only its identity is promised. */
const item = z.looseObject({ id: z.string() });

/** The `{ data, nextCursor }` envelope every list endpoint returns. */
export const pageOutput = z.looseObject({
  data: z.array(item),
  nextCursor: z.string().nullable(),
});

export const emailStatusOutput = z.looseObject({
  id: z.string(),
  status: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  sentAt: z.string().nullable(),
  lastError: z.string().nullable(),
  events: z.array(z.looseObject({ type: z.string(), occurredAt: z.string() })),
});

export const statsOutput = z.looseObject({
  sent: z.looseObject({ today: z.number(), d7: z.number(), d30: z.number() }),
  rates: z.looseObject({
    delivered: z.number(),
    bounced: z.number(),
    complained: z.number(),
  }),
  alerts: z.array(z.looseObject({ kind: z.string(), level: z.string() })),
});
