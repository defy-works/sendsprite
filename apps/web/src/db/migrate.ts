import { migrate } from "drizzle-orm/postgres-js/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import path from "node:path";

/**
 * Session-level advisory lock key. The web server and a separate worker
 * (WORKER_MODE=separate) may boot at the same moment and both run
 * migrations; drizzle's migrator takes no lock of its own, so two racers
 * would each try to create the same tables. The lock serialises them on a
 * single dedicated connection (`max: 1`) so lock and unlock share a session.
 */
const MIGRATION_LOCK = 7245631;

/**
 * Apply pending migrations from ./drizzle. Safe to run on every boot and
 * concurrently from several processes.
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
    await client`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await migrate(drizzle(client), { migrationsFolder: folder });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    await client.end();
  }
}
