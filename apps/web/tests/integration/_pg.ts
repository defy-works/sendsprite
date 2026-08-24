import EmbeddedPostgres from "embedded-postgres";
import { randomBytes, randomInt } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
 */
export async function startPg(): Promise<TestPg> {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    await runMigrations(external);
    process.env.DATABASE_URL = external;
    const db = createDb(external);
    return {
      url: external,
      db,
      async stop() {
        await db.$client.end();
        await closeDb();
      },
    };
  }

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
      await rm(databaseDir, { recursive: true, force: true });
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
    await rm(databaseDir, { recursive: true, force: true });
    if (attempt >= 2) throw err;
    return bootEmbedded(attempt + 1);
  }
}
