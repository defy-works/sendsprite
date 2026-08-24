CREATE TABLE "setup_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"issued_by" text NOT NULL,
	"region" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"region" text NOT NULL,
	"cloudflare_zone_id" text,
	"dns_mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dkim_tokens" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dkim_status" text,
	"mail_from_domain" text NOT NULL,
	"mail_from_status" text,
	"spf_ok" boolean DEFAULT false NOT NULL,
	"dmarc_ok" boolean DEFAULT false NOT NULL,
	"expected_records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"verify_until" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "aws_account_id" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "aws_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "sns_subscription_arn" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "ses_review_status" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "ses_last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "cloudflare_account_name" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "cloudflare_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domains_name_uidx" ON "domains" USING btree ("name");--> statement-breakpoint
CREATE INDEX "domains_team_idx" ON "domains" USING btree ("team_id");