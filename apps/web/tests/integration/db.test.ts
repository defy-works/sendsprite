import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    await pg.db.execute(sql`create database race`);
    const raceUrl = pg.url.replace(/\/[^/]*$/, "/race");
    await expect(
      Promise.all([runMigrations(raceUrl), runMigrations(raceUrl)]),
    ).resolves.toBeDefined();
  });
  it("are idempotent", async () => {
    const { runMigrations } = await import("@/db/migrate");
    await expect(runMigrations(pg.url)).resolves.toBeUndefined();
  });
});
