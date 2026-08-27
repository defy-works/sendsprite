ALTER TABLE "campaigns" ADD COLUMN "sent_notified_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "completed_at" timestamp (3) with time zone;