import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getWorkerState } from "@/jobs/boss";
import { getSmtpState, type SmtpState } from "@/smtp/state";
import { appVersion, sourceUrl } from "@/lib/build-info";

export interface Checks {
  db: "ok" | "error";
  worker: "running" | "disabled" | "stopped";
  /** Seconds the oldest runnable job has been waiting; -1 if unmeasurable. */
  queueLag: number;
  /**
   * Seconds since the freshest `worker_heartbeats` row (any process), or
   * null when no worker has ever checked in. Lets a web container with
   * WORKER_MODE=separate see the worker that runs elsewhere.
   */
  workerLastSeenSeconds: number | null;
  /**
   * The SMTP relay of this process: "disabled" when it was never asked for,
   * "failed" when SMTP_ENABLED but it could not start (a busy or privileged
   * port, unreadable TLS files). A failed relay is not fatal — this is where
   * an operator finds it after the boot log has scrolled away.
   */
  smtp: SmtpState;
}
export interface Health extends Checks {
  status: "ok" | "degraded" | "error";
  version: string;
  /**
   * Where this instance offers its source (AGPL section 13, `SOURCE_URL`).
   * Next to the version on purpose: together they say exactly which code is
   * running here and where to get it.
   */
  sourceUrl: string;
}

/** A heartbeat younger than this counts as a running worker. */
export const HEARTBEAT_RUNNING_S = 10 * 60;
/** Older than this (with no in-process worker) and health is degraded. */
export const HEARTBEAT_STALE_S = 15 * 60;

/**
 * `worker` is "running" when this process polls or another process has
 * checked in within HEARTBEAT_RUNNING_S. Health degrades on queue lag, on a
 * relay that failed to start, or when a worker is expected
 * (`WORKER_MODE !== "none"`) but neither this process nor any heartbeat
 * within HEARTBEAT_STALE_S shows one. Only the database is an "error": the
 * container is still serving usefully without a worker or a relay.
 */
export function summarize(
  c: Checks,
  workerMode = process.env.WORKER_MODE ?? "inline",
): Health {
  const inProcess = c.worker === "running";
  const seen = c.workerLastSeenSeconds;
  const worker =
    !inProcess && seen !== null && seen < HEARTBEAT_RUNNING_S
      ? "running"
      : c.worker;
  const workerMissing =
    !inProcess &&
    workerMode !== "none" &&
    (seen === null || seen >= HEARTBEAT_STALE_S);
  const status =
    c.db === "error"
      ? "error"
      : c.queueLag > 60 || workerMissing || c.smtp.status === "failed"
        ? "degraded"
        : "ok";
  return {
    ...c,
    worker,
    status,
    version: appVersion(),
    sourceUrl: sourceUrl(),
  };
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

/** Age in seconds of the freshest heartbeat row; null when there is none. */
async function workerLastSeen(): Promise<number | null> {
  const rows = await db().execute(
    sql`select extract(epoch from (now() - max(last_seen_at)))::int as age
        from worker_heartbeats`,
  );
  const age = (rows[0] as { age?: number | null } | undefined)?.age;
  return age === null || age === undefined ? null : Number(age);
}

export async function collect(): Promise<Health> {
  let dbState: Checks["db"] = "ok";
  let lag = 0;
  let seen: number | null = null;
  try {
    await db().execute(sql`select 1`);
    lag = await queueLag();
    seen = await workerLastSeen();
  } catch {
    dbState = "error";
  }
  return summarize({
    db: dbState,
    worker: getWorkerState(),
    queueLag: lag,
    workerLastSeenSeconds: seen,
    smtp: getSmtpState(),
  });
}
