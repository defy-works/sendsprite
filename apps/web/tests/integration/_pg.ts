import EmbeddedPostgres from "embedded-postgres";
import { randomBytes, randomInt } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/db/migrate";
import { createDb, type Db } from "@/db";

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
    return { url: external, db: createDb(external), stop: async () => {} };
  }

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
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("test");
  const url = `postgres://postgres:postgres@localhost:${port}/test`;
  await runMigrations(url);
  process.env.DATABASE_URL = url;
  return {
    url,
    db: createDb(url),
    async stop() {
      await pg.stop();
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}
