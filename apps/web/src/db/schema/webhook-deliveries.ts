import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { webhooks } from "./webhooks";

export const WEBHOOK_DELIVERY_STATUSES = [
  "pending",
  "delivered",
  "failed",
  "exhausted",
] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** One delivery (with its retry series) per (webhook, event). */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(), // whd_<ulid>
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
    eventId: text("event_id").notNull(), // evt_… id echoed as Sendsprite-Event-Id
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempt: integer("attempt").notNull().default(0),
    status: text("status", { enum: WEBHOOK_DELIVERY_STATUSES })
      .notNull()
      .default("pending"),
    statusCode: integer("status_code"),
    responseExcerpt: text("response_excerpt"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("webhook_deliveries_webhook_idx").on(t.webhookId, t.createdAt),
    index("webhook_deliveries_retry_idx").on(t.status, t.nextRetryAt),
  ],
);
