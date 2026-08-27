CREATE TABLE "team_aws" (
	"team_id" text PRIMARY KEY NOT NULL,
	"region" text NOT NULL,
	"access_key_enc" text NOT NULL,
	"secret_enc" text NOT NULL,
	"account_id" text,
	"connected_at" timestamp with time zone NOT NULL,
	"config_set" text NOT NULL,
	"sns_topic_arn" text,
	"sns_subscription_arn" text,
	"ses_account_status" text,
	"ses_review_status" text,
	"ses_daily_quota" integer,
	"ses_max_send_rate" double precision,
	"ses_last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_aws_sns_topic_arn_unique" UNIQUE("sns_topic_arn")
);
--> statement-breakpoint
CREATE TABLE "team_cloudflare" (
	"team_id" text PRIMARY KEY NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"token_expires_at" timestamp with time zone,
	"account_name" text,
	"connected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_send_rate" (
	"team_id" text PRIMARY KEY NOT NULL,
	"tokens" double precision DEFAULT 0 NOT NULL,
	"refilled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_settings" ADD COLUMN "setup_completed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "setup_tokens" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "team_aws" ADD CONSTRAINT "team_aws_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_cloudflare" ADD CONSTRAINT "team_cloudflare_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_send_rate" ADD CONSTRAINT "team_send_rate_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_tokens" ADD CONSTRAINT "setup_tokens_team_id_organization_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;