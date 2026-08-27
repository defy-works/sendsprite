import { z } from "zod";
import { API_KEY_PERMISSIONS } from "./api-keys";

/** `GET /me`: what the bearer key can see about itself. */
export const MeObject = z.object({
  team: z.object({ id: z.string(), name: z.string() }),
  apiKey: z.object({
    id: z.string(),
    name: z.string(),
    permission: z.enum(API_KEY_PERMISSIONS),
    keyPrefix: z.string(),
    domainId: z.string().nullable(),
  }),
});
export type MeObject = z.infer<typeof MeObject>;
