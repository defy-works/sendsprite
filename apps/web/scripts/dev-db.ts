/**
 * Local dev Postgres without Docker: runs embedded-postgres persistently in
 * `apps/web/.pgdata` on port 5432 with user/password `sendsprite` and a
 * `sendsprite` database. Matches DATABASE_URL in `.env.example`.
 * Usage: `bun run db:dev` (Ctrl+C stops it).
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";

const databaseDir = path.join(process.cwd(), ".pgdata");
const pg = new EmbeddedPostgres({
  databaseDir,
  port: 5432,
  user: "sendsprite",
  password: "sendsprite",
  persistent: true,
});

if (!existsSync(path.join(databaseDir, "PG_VERSION"))) {
  await pg.initialise();
}
await pg.start();
try {
  await pg.createDatabase("sendsprite");
} catch {
  // already exists
}
console.log(
  "dev postgres ready: postgres://sendsprite:sendsprite@localhost:5432/sendsprite",
);

const shutdown = async () => {
  await pg.stop().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await new Promise(() => undefined);
