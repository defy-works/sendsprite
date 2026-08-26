import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

/** A named audience. Contacts live in exactly one book. */
export const contactBooks = pgTable(
  "contact_books",
  {
    id: text("id").primaryKey(), // cb_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Suggested sender for campaigns from this book (Phase 7); unused for now. */
    defaultFrom: text("default_from"),
    // Millisecond precision: the list cursor round-trips `createdAt` through
    // a JS Date (ms); see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("contact_books_team_created_idx").on(t.teamId, t.createdAt)],
);
export type ContactBook = typeof contactBooks.$inferSelect;

/**
 * One person in one book. `subscribed` is **consent**, not deliverability:
 * `suppressions` is what stops a send, and nothing here writes it. See
 * `services/contacts.ts` and `packages/shared/src/api/contacts.ts`.
 *
 * `teamId` is denormalised from the book on purpose: `POST /contacts/
 * unsubscribe` is by address across the whole team, and the REST layer
 * authorises a contact against the calling key's team. Both would otherwise be
 * a join on every request, and the FK to the book keeps the two consistent.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: text("id").primaryKey(), // ct_<ulid>
    bookId: text("book_id")
      .notNull()
      .references(() => contactBooks.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Normalised (`.trim().toLowerCase()`), and the check constraint below says so. */
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    properties: jsonb("properties")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    subscribed: boolean("subscribed").notNull().default(true),
    unsubscribeReason: text("unsubscribe_reason"),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    // Millisecond precision: the list cursor round-trips `createdAt` through
    // a JS Date (ms); see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    // `$onUpdate` fires only via drizzle `.update()`; the CSV import upserts.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("contacts_book_email_uidx").on(t.bookId, t.email),
    // The team-wide unsubscribe reads by (team, email).
    index("contacts_team_email_idx").on(t.teamId, t.email),
    index("contacts_book_created_idx").on(t.bookId, t.createdAt),
    /*
     * The unique index above compares raw bytes, so `A@b.io` and `a@b.io` are
     * two rows to Postgres — and then `POST /contacts/unsubscribe` misses one
     * of them and a CSV re-import inserts a second copy. The shared contract
     * normalises every address it parses (`.trim().toLowerCase()`); this
     * constraint is what makes that a property of the *table* rather than of
     * whoever happened to write the row, so a seed, a backfill or a future
     * service cannot quietly reintroduce the split. It is deliberately a check
     * rather than a `lower(email)` expression index: the import upserts with
     * `ON CONFLICT (book_id, email)`, which needs a plain-column index to
     * match against.
     *
     * Nothing normalised by the contract can trip it: `z.email()` accepts only
     * ASCII, so `lower`/`btrim` here and `.toLowerCase()`/`.trim()` there
     * agree on every value that can reach the column.
     */
    check("contacts_email_normalised", sql`email = lower(btrim(email))`),
  ],
);
export type Contact = typeof contacts.$inferSelect;
