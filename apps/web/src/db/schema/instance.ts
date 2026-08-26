import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Singleton row (id = 1, enforced by check): the settings that belong to
 * whoever *operates* the deployment, not to any team.
 *
 * AWS and Cloudflare used to live here too. They moved to `team_aws` and
 * `team_cloudflare` when every org started connecting its own accounts — an
 * instance holds no cloud credentials at all now, so nothing here is
 * encrypted.
 */
export const instanceSettings = pgTable(
  "instance_settings",
  {
    id: integer("id").primaryKey().default(1),
    signupMode: text("signup_mode", { enum: ["open", "invite", "closed"] }),
    landingEnabled: boolean("landing_enabled"),
    /**
     * The **maximum** retention any team may choose, not a default. A team
     * picks its own shorter window in `team_settings.retention_days`; lowering
     * this shortens every team that had asked for more.
     */
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
