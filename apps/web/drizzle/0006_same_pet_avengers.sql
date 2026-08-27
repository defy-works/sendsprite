ALTER TABLE "setup_tokens" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "setup_tokens" ADD COLUMN "failed_reason" text;