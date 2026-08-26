import { z } from "zod";

/** One `event: change` message on `/api/v1/stream` (and the dashboard feed). */
export const StreamChange = z.object({
  type: z.enum(["email", "webhook"]),
  id: z.string().optional(),
});
export type StreamChange = z.infer<typeof StreamChange>;
