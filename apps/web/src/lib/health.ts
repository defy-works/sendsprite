import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getWorkerState } from "@/jobs/boss";

export interface Checks {
  db: "ok" | "error";
  worker: "running" | "disabled" | "stopped";
  queueLag: number;
}
export interface Health extends Checks {
  status: "ok" | "degraded" | "error";
  version: string;
}

export function summarize(c: Checks): Health {
  const status =
    c.db === "error" ? "error" : c.queueLag > 60 ? "degraded" : "ok";
  return { ...c, status, version: process.env.npm_package_version ?? "dev" };
}

export async function collect(): Promise<Health> {
  let dbState: Checks["db"] = "ok";
  let queueLag = 0;
  try {
    await db().execute(sql`select 1`);
    // Age of the oldest job still waiting to run. pg-boss creates its
    // schema on first start, so the table may not exist yet (worker
    // disabled or not started) — treat that as no lag.
    const rows = await db()
      .execute(
        sql`select coalesce(extract(epoch from (now() - min(created_on))), 0)::int as lag from pgboss.job where state = 'created'`,
      )
      .catch(() => [{ lag: 0 }]);
    queueLag = Number((rows[0] as { lag?: number } | undefined)?.lag ?? 0);
  } catch {
    dbState = "error";
  }
  return summarize({ db: dbState, worker: getWorkerState(), queueLag });
}
