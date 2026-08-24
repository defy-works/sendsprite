import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
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
    await expect(
      Promise.all([runMigrations(raceUrl), runMigrations(raceUrl)]),
    ).resolves.toBeDefined();
  });
  it("are idempotent", async () => {
    const { runMigrations } = await import("@/db/migrate");
    await expect(runMigrations(pg.url)).resolves.toBeUndefined();
  });
});
