import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * One team's Cloudflare OAuth grant (Manage Account → OAuth clients).
 * Separate from `team_aws` so disconnecting either is a row delete rather
 * than nulling half a wide row, and so the send path never reads Cloudflare
 * columns it does not use.
 */
export const teamCloudflare = pgTable("team_cloudflare", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  accountName: text("account_name"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
