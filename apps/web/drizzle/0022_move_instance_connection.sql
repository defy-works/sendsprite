-- Move the single instance connection onto the oldest organization.
-- Ciphertext is copied verbatim: same APP_SECRET, no re-encryption.
--
-- The legacy resource names ("sendsprite", "sendsprite-events") are copied
-- as-is and MUST NOT be renamed here: those resources already exist in that
-- AWS account under those names, and every read uses the stored value. Only
-- a fresh connect produces slug-scoped names.
--
-- `aws_mode = 'instance_role'` cannot be carried: there are no keys to copy
-- and `team_aws.access_key_enc` is NOT NULL. Such an instance migrates with
-- no row and reconnects through the wizard.
--
-- CROSS JOIN LATERAL rather than a scalar subquery so every statement is a
-- no-op when there are no organizations, instead of inserting a NULL team id.
INSERT INTO team_aws (
  team_id, region, access_key_enc, secret_enc, account_id, connected_at,
  config_set, sns_topic_arn, sns_subscription_arn, ses_account_status,
  ses_review_status, ses_daily_quota, ses_max_send_rate, ses_last_checked_at
)
SELECT
  o.id, s.aws_region, s.aws_access_key_enc, s.aws_secret_enc, s.aws_account_id,
  COALESCE(s.aws_connected_at, now()), COALESCE(s.ses_config_set, 'sendsprite'),
  s.sns_topic_arn, s.sns_subscription_arn, s.ses_account_status,
  s.ses_review_status, s.ses_daily_quota, s.ses_max_send_rate,
  s.ses_last_checked_at
FROM instance_settings s
CROSS JOIN LATERAL (
  SELECT id FROM organization ORDER BY created_at, id LIMIT 1
) o
WHERE s.id = 1
  AND s.aws_mode = 'keys'
  AND s.aws_region IS NOT NULL
  AND s.aws_access_key_enc IS NOT NULL
  AND s.aws_secret_enc IS NOT NULL
ON CONFLICT (team_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO team_cloudflare (
  team_id, access_token_enc, refresh_token_enc, token_expires_at,
  account_name, connected_at
)
SELECT
  o.id, s.cloudflare_access_token_enc, s.cloudflare_refresh_token_enc,
  s.cloudflare_token_expires_at, s.cloudflare_account_name,
  s.cloudflare_connected_at
FROM instance_settings s
CROSS JOIN LATERAL (
  SELECT id FROM organization ORDER BY created_at, id LIMIT 1
) o
WHERE s.id = 1
  AND s.cloudflare_connected_at IS NOT NULL
  AND s.cloudflare_access_token_enc IS NOT NULL
ON CONFLICT (team_id) DO NOTHING;
--> statement-breakpoint
-- Carry the instance's "setup finished" flag to that same team.
INSERT INTO team_settings (team_id, setup_completed, updated_at)
SELECT o.id, s.setup_completed, now()
FROM instance_settings s
CROSS JOIN LATERAL (
  SELECT id FROM organization ORDER BY created_at, id LIMIT 1
) o
WHERE s.id = 1
ON CONFLICT (team_id) DO UPDATE SET
  setup_completed = EXCLUDED.setup_completed, updated_at = now();
--> statement-breakpoint
-- Backfill the team on existing setup tokens so 0023's NOT NULL succeeds.
UPDATE setup_tokens SET team_id = (
  SELECT id FROM organization ORDER BY created_at, id LIMIT 1
) WHERE team_id IS NULL;
--> statement-breakpoint
-- No INSTANCE_ADMIN_EMAILS is visible from SQL, so the oldest user is
-- flagged unconditionally; the env allowlist grants access on top of it and
-- an operator can clear this flag from /app/admin.
UPDATE "user" SET instance_admin = true
WHERE id = (SELECT id FROM "user" ORDER BY created_at, id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM "user" WHERE instance_admin = true);
