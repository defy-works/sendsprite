import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { runMigrations } from "@/db/migrate";
import { createDb } from "@/db";

export async function startPg() {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "postgres:16-alpine",
  ).start();
  const url = container.getConnectionUri();
  await runMigrations(url);
  process.env.DATABASE_URL = url;
  return { container, url, db: createDb(url) };
}
