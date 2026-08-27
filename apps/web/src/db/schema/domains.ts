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
    /**
     * Zone name detected from the domain's nameservers, set whether or not
     * Cloudflare is connected. Null means "not on Cloudflare" (or not yet
     * checked), and is what hides the dashboard deep link.
     */
    cloudflareZone: text("cloudflare_zone"),
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
    /**
     * When the records were last written to the Cloudflare zone by Apply.
     * Null until the owner clicks — provisioning stores what SES issued and
     * stops, it never writes DNS on its own — and always null in manual mode.
     */
    dnsAppliedAt: timestamp("dns_applied_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifyUntil: timestamp("verify_until", { withTimezone: true }),
    createdBy: text("created_by"),
    // Millisecond precision: the keyset cursor round-trips `createdAt`
    // through a JS Date (ms); see schema/emails.ts.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
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
