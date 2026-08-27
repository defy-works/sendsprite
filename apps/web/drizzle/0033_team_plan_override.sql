ALTER TABLE "team_settings" ADD COLUMN "plan_override" text;--> statement-breakpoint
ALTER TABLE "team_settings" ADD COLUMN "plan_override_by" text;--> statement-breakpoint
ALTER TABLE "team_settings" ADD COLUMN "plan_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_settings" ADD CONSTRAINT "team_settings_plan_override_complete" CHECK ((plan_override IS NULL) = (plan_override_at IS NULL) AND (plan_override IS NULL) = (plan_override_by IS NULL));