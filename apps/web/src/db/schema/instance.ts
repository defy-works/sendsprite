import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Singleton row (id = 1, enforced by check). Encrypted columns end in `_enc`. */
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: integer("id").primaryKey().default(1),
    setupCompleted: boolean("setup_completed").notNull().default(false),
    signupMode: text("signup_mode", { enum: ["open", "invite", "closed"] }),
    landingEnabled: boolean("landing_enabled"),
    awsMode: text("aws_mode", { enum: ["none", "instance_role", "keys"] })
      .notNull()
      .default("none"),
    awsRegion: text("aws_region"),
    awsAccessKeyEnc: text("aws_access_key_enc"),
    awsSecretEnc: text("aws_secret_enc"),
    snsTopicArn: text("sns_topic_arn"),
    sesConfigSet: text("ses_config_set"),
    sesAccountStatus: text("ses_account_status", {
      enum: ["sandbox", "requested", "production"],
    }),
    sesMaxSendRate: doublePrecision("ses_max_send_rate"),
    sesDailyQuota: integer("ses_daily_quota"),
    cloudflareTokenEnc: text("cloudflare_token_enc"),
    retentionDays: integer("retention_days").notNull().default(90),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  () => [check("instance_settings_singleton", sql`id = 1`)],
);
