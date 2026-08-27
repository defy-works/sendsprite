ALTER TABLE "send_rate_state" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "send_rate_state" CASCADE;--> statement-breakpoint
ALTER TABLE "setup_tokens" ALTER COLUMN "team_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "setup_completed";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "aws_mode";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "aws_region";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "aws_access_key_enc";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "aws_secret_enc";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "sns_topic_arn";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "ses_config_set";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "ses_account_status";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "ses_max_send_rate";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "ses_daily_quota";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "aws_account_id";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "aws_connected_at";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "sns_subscription_arn";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "ses_review_status";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "ses_last_checked_at";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "cloudflare_access_token_enc";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "cloudflare_refresh_token_enc";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "cloudflare_token_expires_at";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "cloudflare_account_name";--> statement-breakpoint
ALTER TABLE "instance_settings" DROP COLUMN "cloudflare_connected_at";