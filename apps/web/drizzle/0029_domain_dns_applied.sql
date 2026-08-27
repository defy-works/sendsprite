ALTER TABLE "domains" ADD COLUMN "dns_applied_at" timestamp with time zone;--> statement-breakpoint
-- Domains whose records were written by the old auto-apply provisioning
-- carry Cloudflare ids; they count as applied, at their last update.
UPDATE "domains" SET "dns_applied_at" = "updated_at"
  WHERE "dns_mode" = 'auto' AND "expected_records"::text LIKE '%cloudflareId%';
