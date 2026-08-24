import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getWorkerState } from "@/jobs/boss";

export interface Checks {
  db: "ok" | "error";
  worker: "running" | "disabled" | "stopped";
  /** Seconds the oldest runnable job has been waiting; -1 if unmeasurable. */
  queueLag: number;
}
export interface Health extends Checks {
  status: "ok" | "degraded" | "error";
  version: string;
}

export function summarize(c: Checks): Health {
  const status =
    c.db === "error" ? "error" : c.queueLag > 60 ? "degraded" : "ok";
  return { ...c, status, version: process.env.APP_VERSION ?? "dev" };
}

// Postgres SQLSTATEs: undefined_table / invalid_schema_name. pg-boss creates
// its schema on first start, so neither exists while the worker is disabled.
const MISSING_RELATION = new Set(["42P01", "3F000"]);

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

/** Age in seconds of the oldest job that is due but not yet picked up. */
async function queueLag(): Promise<number> {
  try {
    const rows = await db().execute(
      sql`select coalesce(extract(epoch from (now() - min(start_after))), 0)::int as lag
          from pgboss.job
          where state in ('created', 'retry') and start_after <= now()`,
    );
    return Number((rows[0] as { lag?: number } | undefined)?.lag ?? 0);
  } catch (err) {
    if (MISSING_RELATION.has(sqlState(err) ?? "")) return 0;
    console.error("[health] queue lag query failed", err);
    return -1;
  }
}

export async function collect(): Promise<Health> {
  let dbState: Checks["db"] = "ok";
  let lag = 0;
  try {
    await db().execute(sql`select 1`);
    lag = await queueLag();
  } catch {
    dbState = "error";
  }
  return summarize({ db: dbState, worker: getWorkerState(), queueLag: lag });
}
