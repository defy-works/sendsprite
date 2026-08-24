import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";

/** Apply pending migrations from ./drizzle. Safe to run on every boot. */
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
