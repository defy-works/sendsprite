import { PgBoss, type Job } from "pg-boss";
import { Q } from "./queues";
import { heartbeat } from "./handlers/heartbeat";

type WorkerState = "running" | "disabled" | "stopped";
export type JobHandler = (jobs: Job<object>[]) => Promise<unknown>;

interface Registration {
  name: string;
  handler: JobHandler;
  cron?: string;
}

// Shared across bundles: Next evaluates this module once for the
// instrumentation hook and again for route handlers, and dev HMR
// re-evaluates it on reload. A plain module variable would report
// "disabled" from /api/health while the worker is running.
interface Shared {
  state: WorkerState;
  boss?: PgBoss;
  registry: Map<string, Registration>;
}
const g = globalThis as { __sendspriteBoss?: Shared };
const shared: Shared = (g.__sendspriteBoss ??= {
  state: "disabled",
  registry: new Map(),
});

export function getWorkerState(): WorkerState {
  return shared.state;
}

/**
 * Register a queue and its handler; `startWorker()` creates the queue,
 * attaches the handler and, when `cron` is given, schedules it.
 * Registering the same name again replaces the earlier entry.
 */
export function registerQueue(
  name: string,
  handler: JobHandler,
  opts: { cron?: string } = {},
) {
  shared.registry.set(name, { name, handler, cron: opts.cron });
}

registerQueue(
  Q.heartbeat,
  async () => {
    await heartbeat();
  },
  { cron: "*/5 * * * *" },
);

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

/** Create every registered queue, attach handlers and begin polling. Idempotent. */
export async function startWorker() {
  if (shared.state === "running") return;
  const b = await getBoss();
  for (const { name, handler, cron } of shared.registry.values()) {
    await b.createQueue(name);
    if (cron) await b.schedule(name, cron);
    await b.work(name, handler);
  }
  shared.state = "running";
  console.info("[worker] started");
}

export async function stopWorker() {
  const b = shared.boss;
  if (!b) return;
  await b.stop({ graceful: true, timeout: 10_000 });
  shared.boss = undefined;
  shared.state = "stopped";
}
