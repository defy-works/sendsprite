import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startPg } from "./_pg";

/**
 * Migration 0022 moves the one instance-wide AWS/Cloudflare connection onto
 * the oldest organization.
 *
 * The database `startPg()` hands back is already fully migrated, so 0023 has
 * dropped the source columns. To exercise 0022 honestly the columns are put
 * back, filled with what a pre-migration instance looked like, and the real
 * migration file is replayed against them.
 */
let pg: Awaited<ReturnType<typeof startPg>>;
beforeEach(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
});
afterEach(async () => {
  await pg.stop();
});

const MIGRATION = path.join(
  import.meta.dirname,
  "../../drizzle/0022_move_instance_connection.sql",
);

async function replay0022() {
  const sqlText = readFileSync(MIGRATION, "utf8");
  for (const stmt of sqlText.split("--> statement-breakpoint")) {
    if (stmt.trim()) await pg.db.execute(sql.raw(stmt));
  }
}

/** Re-create the columns 0023 dropped, so 0022 has something to read. */
async function restorePreMigrationColumns() {
  await pg.db.execute(
    sql.raw(`ALTER TABLE instance_settings
      ADD COLUMN aws_mode text NOT NULL DEFAULT 'none',
      ADD COLUMN aws_region text,
      ADD COLUMN aws_access_key_enc text,
      ADD COLUMN aws_secret_enc text,
      ADD COLUMN aws_account_id text,
      ADD COLUMN aws_connected_at timestamptz,
      ADD COLUMN sns_topic_arn text,
      ADD COLUMN sns_subscription_arn text,
      ADD COLUMN ses_config_set text,
      ADD COLUMN ses_account_status text,
      ADD COLUMN ses_review_status text,
      ADD COLUMN ses_daily_quota integer,
      ADD COLUMN ses_max_send_rate double precision,
      ADD COLUMN ses_last_checked_at timestamptz,
      ADD COLUMN cloudflare_access_token_enc text,
      ADD COLUMN cloudflare_refresh_token_enc text,
      ADD COLUMN cloudflare_token_expires_at timestamptz,
      ADD COLUMN cloudflare_account_name text,
      ADD COLUMN cloudflare_connected_at timestamptz,
      ADD COLUMN setup_completed boolean NOT NULL DEFAULT false`),
  );
}

async function seedOrgs() {
  await pg.db.execute(
    sql.raw(`INSERT INTO organization(id,name,slug,created_at) VALUES
      ('org_old','Older','older','2026-01-01T00:00:00Z'),
      ('org_new','Newer','newer','2026-06-01T00:00:00Z')`),
  );
}

async function seedConnectedInstance(mode = "keys") {
  await pg.db.execute(
    sql.raw(`INSERT INTO instance_settings
      (id, aws_mode, aws_region, aws_access_key_enc, aws_secret_enc,
       aws_account_id, aws_connected_at, ses_config_set, sns_topic_arn,
       sns_subscription_arn, ses_account_status, ses_daily_quota,
       ses_max_send_rate, cloudflare_access_token_enc,
       cloudflare_refresh_token_enc, cloudflare_account_name,
       cloudflare_connected_at, setup_completed)
      VALUES (1, '${mode}', 'eu-west-1', 'v1.enc-key', 'v1.enc-secret',
       '123456789012', now(), 'sendsprite',
       'arn:aws:sns:eu-west-1:1:sendsprite-events',
       'arn:aws:sns:eu-west-1:1:sendsprite-events:sub', 'production', 50000,
       14, 'v1.cf-access', 'v1.cf-refresh', 'acme.com', now(), true)
      ON CONFLICT (id) DO UPDATE SET aws_mode = EXCLUDED.aws_mode`),
  );
}

const rows = (q: string) => pg.db.execute(sql.raw(q));

describe("migration 0022", () => {
  it("moves the connection to the oldest organization", async () => {
    await restorePreMigrationColumns();
    await seedOrgs();
    await seedConnectedInstance();
    await replay0022();

    const aws = await rows("SELECT * FROM team_aws");
    expect(aws).toHaveLength(1);
    expect(aws[0]).toMatchObject({
      team_id: "org_old",
      region: "eu-west-1",
      account_id: "123456789012",
      ses_daily_quota: 50000,
    });
    // Ciphertext is copied verbatim — same key, no re-encryption.
    expect(aws[0]?.access_key_enc).toBe("v1.enc-key");
    expect(aws[0]?.secret_enc).toBe("v1.enc-secret");
    // The legacy unslugged names survive: those resources exist in that AWS
    // account under exactly these names.
    expect(aws[0]?.config_set).toBe("sendsprite");
    expect(aws[0]?.sns_topic_arn).toBe(
      "arn:aws:sns:eu-west-1:1:sendsprite-events",
    );

    const cf = await rows("SELECT * FROM team_cloudflare");
    expect(cf).toHaveLength(1);
    expect(cf[0]).toMatchObject({
      team_id: "org_old",
      access_token_enc: "v1.cf-access",
      account_name: "acme.com",
    });

    const ts = await rows(
      "SELECT team_id, setup_completed FROM team_settings",
    );
    expect(ts).toEqual([{ team_id: "org_old", setup_completed: true }]);
  });

  it("flags the oldest user as instance admin", async () => {
    await restorePreMigrationColumns();
    await seedOrgs();
    await seedConnectedInstance();
    await pg.db.execute(
      sql.raw(`INSERT INTO "user"(id,name,email,created_at) VALUES
        ('u_old','Old','old@x.com','2026-01-01T00:00:00Z'),
        ('u_new','New','new@x.com','2026-05-01T00:00:00Z')`),
    );
    await replay0022();
    const admins = await rows(
      `SELECT id FROM "user" WHERE instance_admin = true`,
    );
    expect(admins).toEqual([{ id: "u_old" }]);
  });

  it("carries nothing for an instance_role instance (no keys to copy)", async () => {
    await restorePreMigrationColumns();
    await seedOrgs();
    await seedConnectedInstance("instance_role");
    await replay0022();
    // No team_aws row: such an instance must reconnect with an IAM user.
    expect(await rows("SELECT * FROM team_aws")).toHaveLength(0);
    // The Cloudflare grant is independent of the AWS mode and still moves.
    expect(await rows("SELECT * FROM team_cloudflare")).toHaveLength(1);
  });

  it("is a no-op when there are no organizations", async () => {
    await restorePreMigrationColumns();
    await seedConnectedInstance();
    await replay0022();
    expect(await rows("SELECT * FROM team_aws")).toHaveLength(0);
    expect(await rows("SELECT * FROM team_cloudflare")).toHaveLength(0);
    expect(await rows("SELECT * FROM team_settings")).toHaveLength(0);
  });

  it("backfills the team on pending setup tokens", async () => {
    await restorePreMigrationColumns();
    await seedOrgs();
    await seedConnectedInstance();
    await pg.db.execute(
      sql.raw(`INSERT INTO "user"(id,name,email) VALUES ('u1','U','u@x.com')`),
    );
    // 0023 made the column NOT NULL, so relax it to recreate the 0021 state.
    await pg.db.execute(
      sql.raw(`ALTER TABLE setup_tokens ALTER COLUMN team_id DROP NOT NULL`),
    );
    await pg.db.execute(
      sql.raw(`INSERT INTO setup_tokens(id,purpose,token_hash,issued_by,region,expires_at)
        VALUES ('stok_1','aws_callback','h','u1','eu-west-1', now() + interval '1 hour')`),
    );
    await replay0022();
    const tok = await rows("SELECT team_id FROM setup_tokens");
    expect(tok).toEqual([{ team_id: "org_old" }]);
  });
});
