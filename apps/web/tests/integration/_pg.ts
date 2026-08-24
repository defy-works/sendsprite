import EmbeddedPostgres from "embedded-postgres";
import { randomBytes, randomInt } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { runMigrations } from "@/db/migrate";
import { closeDb, createDb, type Db } from "@/db";

export interface TestPg {
  url: string;
  db: Db;
  stop(): Promise<void>;
}

/**
 * Migrated Postgres for integration tests.
 * Uses TEST_DATABASE_URL when set (CI service container); otherwise boots an
 * embedded Postgres in a temp dir. No Docker required.
 *
 * Either way every call gets its own fresh database: vitest runs test files
 * in parallel and each file assumes an empty, freshly migrated schema.
 */
export async function startPg(): Promise<TestPg> {
  const external = process.env.TEST_DATABASE_URL;
  if (external) return startExternal(external);

  const { pg, databaseDir, port } = await bootEmbedded();
  const url = `postgres://postgres:postgres@localhost:${port}/test`;
  await runMigrations(url);
  process.env.DATABASE_URL = url;
  const db = createDb(url);
  return {
    url,
    db,
    async stop() {
      await db.$client.end();
      await closeDb();
      await pg.stop();
      try {
        await rm(databaseDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      } catch (e) {
        // Windows can still hold the data dir (EBUSY) right after stop; a
        // stale temp dir is not worth failing the run.
        console.warn("[pg] cleanup failed", (e as { code?: string })?.code);
      }
    },
  };
}

/**
 * External server (TEST_DATABASE_URL points at an admin database): create a
 * throwaway `test_<hex>` database next to it, migrate it, and drop it (FORCE,
 * Postgres 13+) on stop so parallel test files never share state.
 */
async function startExternal(adminUrl: string): Promise<TestPg> {
  const name = `test_${randomBytes(4).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  await runMigrations(url);
  process.env.DATABASE_URL = url;
  const db = createDb(url);
  return {
    url,
    db,
    async stop() {
      await db.$client.end();
      await closeDb();
      await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Start an embedded Postgres; retry once on a fresh dir/port (port clash). */
async function bootEmbedded(attempt = 1): Promise<{
  pg: EmbeddedPostgres;
  databaseDir: string;
  port: number;
}> {
  const databaseDir = path.join(
    os.tmpdir(),
    `sendsprite-pg-${randomBytes(6).toString("hex")}`,
  );
  const port = 54000 + randomInt(1000);
  const pg = new EmbeddedPostgres({
    databaseDir,
    port,
    user: "postgres",
    password: "postgres",
    persistent: false,
  });
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("test");
    return { pg, databaseDir, port };
  } catch (err) {
    await pg.stop().catch(() => undefined);
    await rm(databaseDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    if (attempt >= 2) throw err;
    return bootEmbedded(attempt + 1);
  }
}
