import {
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * One team's AWS connection. **The row's existence is the connection** —
 * there is no `mode: "none"`, and `getTeamAws` returning null is what every
 * "is AWS connected?" check reads.
 *
 * The old `instance_role` mode is gone: it meant "whatever the SDK's default
 * chain finds on this host", and one process has exactly one ambient
 * identity, so it can never serve more than one tenant. `keys` was then the
 * only mode left, which is why there is no mode column and why the key
 * columns are `notNull`.
 *
 * `configSet` and `snsTopicArn` hold the names actually created in the
 * tenant's account. They are derived from the org slug at connect time and
 * never re-derived: slugs are mutable.
 *
 * Encrypted columns end in `_enc`, matching the project-wide convention.
 */
export const teamAws = pgTable("team_aws", {
  teamId: text("team_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  region: text("region").notNull(),
  accessKeyEnc: text("access_key_enc").notNull(),
  secretEnc: text("secret_enc").notNull(),
  accountId: text("account_id"),
  connectedAt: timestamp("connected_at", { withTimezone: true }).notNull(),
  configSet: text("config_set").notNull(),
  /** Unique: two teams sharing one topic would cross-deliver events. */
  snsTopicArn: text("sns_topic_arn").unique(),
  snsSubscriptionArn: text("sns_subscription_arn"),
  sesAccountStatus: text("ses_account_status", {
    enum: ["sandbox", "requested", "production"],
  }),
  sesReviewStatus: text("ses_review_status", {
    enum: ["PENDING", "GRANTED", "DENIED", "FAILED"],
  }),
  sesDailyQuota: integer("ses_daily_quota"),
  sesMaxSendRate: doublePrecision("ses_max_send_rate"),
  sesLastCheckedAt: timestamp("ses_last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // `$onUpdate` does not fire on `onConflictDoUpdate`; upserts set this
  // explicitly (same note as team-settings.ts).
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
