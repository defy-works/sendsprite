ALTER TABLE "instance_settings" ADD COLUMN "cloudflare_access_token_enc" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "cloudflare_refresh_token_enc" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "cloudflare_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "cloudflare_zone" text;