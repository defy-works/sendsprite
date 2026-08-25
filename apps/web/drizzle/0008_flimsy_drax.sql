ALTER TABLE "emails" DROP CONSTRAINT "emails_domain_id_domains_id_fk";
--> statement-breakpoint
ALTER TABLE "emails" ALTER COLUMN "domain_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_rate_state" ADD CONSTRAINT "send_rate_state_singleton" CHECK (id = 1);