import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

export type DnsRecordKind = "DKIM" | "MAIL_FROM_MX" | "MAIL_FROM_SPF" | "DMARC";
export interface ExpectedRecord {
  kind: DnsRecordKind;
  type: "CNAME" | "MX" | "TXT";
  name: string; // fully-qualified, no trailing dot
  value: string;
  priority?: number; // MX only
  cloudflareId?: string; // set in auto mode after upsert
  ok: boolean; // last check result
}

/** Sending domains (spec §5). A domain name is unique across the instance. */
export const domains = pgTable(
  "domains",
  {
    id: text("id").primaryKey(), // dom_<ulid>
    teamId: text("team_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    region: text("region").notNull(),
    cloudflareZoneId: text("cloudflare_zone_id"),
    dnsMode: text("dns_mode", { enum: ["auto", "manual"] }).notNull(),
    status: text("status", { enum: ["pending", "verified", "failed"] })
      .notNull()
      .default("pending"),
    dkimTokens: jsonb("dkim_tokens").$type<string[]>().notNull().default([]),
    dkimStatus: text("dkim_status"),
    mailFromDomain: text("mail_from_domain").notNull(),
    mailFromStatus: text("mail_from_status"),
    spfOk: boolean("spf_ok").notNull().default(false),
    dmarcOk: boolean("dmarc_ok").notNull().default(false),
    expectedRecords: jsonb("expected_records")
      .$type<ExpectedRecord[]>()
      .notNull()
      .default([]),
    lastError: text("last_error"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifyUntil: timestamp("verify_until", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // `$onUpdate` fires only via drizzle `.update()`; upserts must set it.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("domains_name_uidx").on(t.name),
    index("domains_team_idx").on(t.teamId),
  ],
);
