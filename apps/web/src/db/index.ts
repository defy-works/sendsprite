import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const client = postgres(url, { max: 10, prepare: false });
  return drizzle(client, { schema });
}

let _db: Db | undefined;
export function db(): Db {
  _db ??= createDb(process.env.DATABASE_URL!);
  return _db;
}
