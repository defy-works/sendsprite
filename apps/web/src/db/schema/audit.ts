import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(), // aud_<ulid>
    teamId: text("team_id"), // null = instance-level
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(), // e.g. "team.rename"
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    diff: jsonb("diff").$type<
      Record<string, { from?: unknown; to?: unknown }>
    >(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("audit_log_team_created_idx").on(t.teamId, t.createdAt)],
);
