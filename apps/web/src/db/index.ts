import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

/**
 * Connection budget per process: app pool 10 + pg-boss ~10 + migrator 1.
 * With WORKER_MODE=separate there are two processes, so double it when
 * sizing Postgres `max_connections`.
 */
export function createDb(url: string) {
  const client = postgres(url, { max: 10 });
  return drizzle(client, { schema });
}

let _db: Db | undefined;
// Outside production the singleton lives on globalThis: Next dev HMR
// re-evaluates this module and would otherwise leak a pool per reload.
const g = globalThis as { __sendspriteDb?: Db };

export function db(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (process.env.NODE_ENV === "production") return (_db ??= createDb(url));
  return (g.__sendspriteDb ??= createDb(url));
}

export async function closeDb() {
  await _db?.$client.end();
  await g.__sendspriteDb?.$client.end();
  _db = undefined;
  g.__sendspriteDb = undefined;
}
