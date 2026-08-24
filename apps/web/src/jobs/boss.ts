import { PgBoss, type Job } from "pg-boss";

type WorkerState = "running" | "disabled" | "stopped";
export type JobHandler<T extends object = object> = (
  jobs: Job<T>[],
) => Promise<unknown>;

interface Registration {
  name: string;
  handler: JobHandler<never>;
  cron?: string;
}

interface Shared {
  state: WorkerState;
  boss?: PgBoss;
  starting?: Promise<void>;
  registry: Map<string, Registration>;
}

// Shared across bundles: Next evaluates this module once for the
// instrumentation hook and again for route handlers, and dev HMR
// re-evaluates it on reload. A plain module variable would report
// "disabled" from /api/health while the worker is running.
//
// HMR caveat: handlers are attached to pg-boss once at start. Editing a
// handler in dev updates the module but not the running worker — restart
// `next dev` to pick the change up.
const g = globalThis as { __sendspriteBoss?: Shared };
const shared: Shared = (g.__sendspriteBoss ??= {
  state: "disabled",
  registry: new Map(),
});

export function getWorkerState(): WorkerState {
  return shared.state;
}

async function attach(b: PgBoss, { name, handler, cron }: Registration) {
  await b.createQueue(name);
  if (cron) await b.schedule(name, cron);
  await b.work(name, handler as JobHandler);
}

/**
 * Register a queue and its handler. Before `startWorker()` the entry is
 * queued up; while running, the queue is created and attached right away.
 * Registering the same name again replaces the earlier entry.
 */
export function registerQueue<T extends object>(
  name: string,
  handler: JobHandler<T>,
  opts: { cron?: string } = {},
) {
  const reg: Registration = { name, handler, cron: opts.cron };
  shared.registry.set(name, reg);
  if (shared.state === "running" && shared.boss) {
    void attach(shared.boss, reg).catch((err) =>
      console.error(`[worker] failed to attach queue ${name}`, err),
    );
  }
}

export async function getBoss(): Promise<PgBoss> {
  if (shared.boss) return shared.boss;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const boss = new PgBoss({ connectionString: url, schema: "pgboss" });
  boss.on("error", (e) => console.error("[pg-boss]", e));
  await boss.start();
  shared.boss = boss;
  return boss;
}

/**
 * Create every registered queue, attach handlers and begin polling.
 * Idempotent and re-entrant: concurrent callers await the same start.
 */
export async function startWorker(): Promise<void> {
  if (shared.state === "running") return;
  if (shared.starting) return shared.starting;
  shared.starting = (async () => {
    await import("./handlers");
    const b = await getBoss();
    for (const reg of shared.registry.values()) await attach(b, reg);
    shared.state = "running";
    console.info(
      `[worker] started (${[...shared.registry.keys()].join(", ")})`,
    );
  })().finally(() => {
    shared.starting = undefined;
  });
  return shared.starting;
}

/** Stop polling and close the pool. State stays "disabled" if never started. */
export async function stopWorker() {
  if (shared.starting) await shared.starting.catch(() => undefined);
  const b = shared.boss;
  if (!b) return;
  await b.stop({ graceful: true, timeout: 10_000 });
  shared.boss = undefined;
  shared.state = "stopped";
}
