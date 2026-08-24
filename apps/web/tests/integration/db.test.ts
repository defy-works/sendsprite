import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.container.stop();
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
  it("are idempotent", async () => {
    const { runMigrations } = await import("@/db/migrate");
    await expect(runMigrations(pg.url)).resolves.toBeUndefined();
  });
});
