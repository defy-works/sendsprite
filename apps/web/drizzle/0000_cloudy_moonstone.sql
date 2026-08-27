CREATE TABLE "instance_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"setup_completed" boolean DEFAULT false NOT NULL,
	"signup_mode" text,
	"landing_enabled" boolean,
	"aws_mode" text DEFAULT 'none' NOT NULL,
	"aws_region" text,
	"aws_access_key_enc" text,
	"aws_secret_enc" text,
	"sns_topic_arn" text,
	"ses_config_set" text,
	"ses_account_status" text,
	"ses_max_send_rate" integer,
	"ses_daily_quota" integer,
	"cloudflare_token_enc" text,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"diff" jsonb,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_team_created_idx" ON "audit_log" USING btree ("team_id","created_at");