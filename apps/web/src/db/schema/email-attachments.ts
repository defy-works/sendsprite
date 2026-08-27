import {
  customType,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { emails } from "./emails";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** Attachment bytes; removed with the parent email (cascade) or by retention. */
export const emailAttachments = pgTable("email_attachments", {
  id: text("id").primaryKey(), // att_<ulid>
  emailId: text("email_id")
    .notNull()
    .references(() => emails.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  bytes: bytea("bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
