import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { domains, emails, organization } from "@/db/schema";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

describe("migrations", () => {
  it("create the foundation tables", async () => {
    const rows = await pg.db.execute(
      sql`select table_name from information_schema.tables where table_schema='public' order by 1`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining(["instance_settings", "audit_log"]),
    );
  });
  it("tolerate two processes migrating at once", async () => {
    const { runMigrations } = await import("@/db/migrate");
    // Fresh name per run: TEST_DATABASE_URL may point at a reused server.
    const name = `race_${randomBytes(4).toString("hex")}`;
    await pg.db.execute(sql.raw(`create database ${name}`));
    const raceUrl = pg.url.replace(/\/[^/]*$/, `/${name}`);
    try {
      await expect(
        Promise.all([runMigrations(raceUrl), runMigrations(raceUrl)]),
      ).resolves.toBeDefined();
    } finally {
      await pg.db.execute(sql.raw(`drop database ${name}`));
    }
  });
  it("creates team_settings with cascade to organization", async () => {
    const rows = await pg.db.execute(
      sql`select table_name from information_schema.tables where table_schema='public'`,
    );
    expect(rows.map((r) => r.table_name)).toContain("team_settings");
    const fks = await pg.db.execute(
      sql`select rc.delete_rule from information_schema.referential_constraints rc
          join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
          where tc.table_name = 'team_settings'`,
    );
    expect(fks.map((r) => r.delete_rule)).toEqual(["CASCADE"]);
  });
  it("creates setup_tokens and domains with a unique name index", async () => {
    const rows = await pg.db.execute(
      sql`select table_name from information_schema.tables where table_schema='public'`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(["setup_tokens", "domains"]),
    );
    const idx = await pg.db.execute(
      sql`select indexdef from pg_indexes where tablename = 'domains' and indexname = 'domains_name_uidx'`,
    );
    expect(idx).toHaveLength(1);
    expect(String(idx[0]?.indexdef)).toMatch(/^CREATE UNIQUE INDEX/);
    const fks = await pg.db.execute(
      sql`select rc.delete_rule from information_schema.referential_constraints rc
          join information_schema.table_constraints tc on tc.constraint_name = rc.constraint_name
          where tc.table_name = 'domains'`,
    );
    expect(fks.map((r) => r.delete_rule)).toEqual(["CASCADE"]);
  });
  it("creates the sending tables with the expected constraints", async () => {
    const rows = await pg.db.execute(
      sql`select table_name from information_schema.tables where table_schema='public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of [
      "api_keys",
      "emails",
      "email_attachments",
      "email_events",
      "suppressions",
      "webhooks",
      "webhook_deliveries",
      "send_rate_state",
      "worker_heartbeats",
    ])
      expect(names).toContain(t);
    const idx = await pg.db.execute(
      sql`select indexname from pg_indexes where tablename in ('emails','email_events','suppressions','api_keys')`,
    );
    const idxNames = idx.map((r) => r.indexname);
    expect(idxNames).toEqual(
      expect.arrayContaining([
        "emails_team_idempotency_uidx",
        "emails_ses_message_uidx",
        "email_events_dedupe_uidx",
        "suppressions_team_email_uidx",
        "api_keys_hash_uidx",
      ]),
    );
  });
  it("lets the mail log outlive its domain and tolerates NULL unique keys", async () => {
    await pg.db
      .insert(organization)
      .values({ id: "org_db", name: "Db", slug: "db", createdAt: new Date() });
    await pg.db.insert(domains).values({
      id: "dom_db",
      teamId: "org_db",
      name: "db.example.com",
      region: "eu-west-1",
      dnsMode: "manual",
      mailFromDomain: "mail.db.example.com",
    });
    const row = (id: string) => ({
      id,
      teamId: "org_db",
      domainId: "dom_db",
      from: "a@db.example.com",
      fromEmail: "a@db.example.com",
      to: ["r@x.io"],
      subject: "s",
      text: "t",
    });
    // Two rows with NULL idempotency_key / ses_message_id must not collide.
    await pg.db.insert(emails).values([row("em_db1"), row("em_db2")]);
    await pg.db.delete(domains).where(sql`id = 'dom_db'`);
    const after = await pg.db.execute(
      sql`select domain_id from emails where team_id = 'org_db'`,
    );
    expect(after.map((r) => r.domain_id)).toEqual([null, null]);
    // Singleton check on send_rate_state (drizzle wraps the PG error, so
    // assert the constraint exists and that a second row is rejected).
    const chk = await pg.db.execute(
      sql`select conname from pg_constraint where conname = 'send_rate_state_singleton'`,
    );
    expect(chk).toHaveLength(1);
    await expect(
      pg.db.execute(sql`insert into send_rate_state (id) values (2)`),
    ).rejects.toThrow();
  });
  it("are idempotent", async () => {
    const { runMigrations } = await import("@/db/migrate");
    await expect(runMigrations(pg.url)).resolves.toBeUndefined();
  });
});
