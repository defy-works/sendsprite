ALTER TABLE "team_settings" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_settings" ADD COLUMN "suspended_reason" text;