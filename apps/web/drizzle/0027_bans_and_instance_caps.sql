ALTER TABLE "user" ADD COLUMN "banned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banned_reason" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "default_daily_limit" integer;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "default_monthly_limit" integer;