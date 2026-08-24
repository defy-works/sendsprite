import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";

/**
 * Apply pending migrations from ./drizzle. Safe to run on every boot.
 *
 * The default folder is resolved from `process.cwd()`, which is correct for
 * both `next dev` (cwd = apps/web) and the standalone image (`server.js`
 * chdirs to its own directory, where the Dockerfile copies `drizzle/`).
 * `import.meta.dirname` would point inside the bundled output and break.
 */
export async function runMigrations(
  url: string,
  folder = path.join(process.cwd(), "drizzle"),
) {
  const client = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end();
  }
}
