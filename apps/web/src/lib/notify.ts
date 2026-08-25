import { sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "@/db";

/**
 * Postgres NOTIFY channel for one team's SSE listeners. Identifiers are
 * capped at 63 bytes (NAMEDATALEN - 1); Postgres would truncate silently,
 * so the name is cut here and both sides agree. Team ids are 20-30 chars.
 */
export const teamChannel = (teamId: string) =>
  `ss_team_${teamId.replace(/[^a-zA-Z0-9_]/g, "_")}`.slice(0, 63);

/** Best-effort Postgres NOTIFY for SSE listeners. Never throws. */
export async function notifyTeam(
  teamId: string,
  payload: { type: string; id?: string },
): Promise<void> {
  try {
    await db().execute(
      sql`select pg_notify(${teamChannel(teamId)}, ${JSON.stringify(payload)})`,
    );
  } catch (e) {
    console.warn("[notify]", (e as Error).message);
  }
}

// One LISTEN connection per process, outside the app pool: postgres-js
// dedicates a connection to LISTEN and multiplexes every channel over it.
// Kept on globalThis so Next dev HMR (which re-evaluates this module) does
// not open a connection per reload; in production the module loads once.
type Listener = ReturnType<typeof postgres>;
const g = globalThis as {
  __sendspriteListener?: Listener;
  __sendspriteListenerCounts?: Map<string, number>;
};

function listener(): Listener {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return (g.__sendspriteListener ??= postgres(url, { max: 1 }));
}
const counts = () => (g.__sendspriteListenerCounts ??= new Map());

/**
 * Subscribe to a team's notifications. Resolves once the LISTEN is active,
 * to an unsubscribe function (the connection stays open for other teams).
 */
export async function listenTeam(
  teamId: string,
  cb: (payload: string) => void,
): Promise<() => Promise<void>> {
  const ch = teamChannel(teamId);
  const { unlisten } = await listener().listen(ch, cb);
  counts().set(ch, (counts().get(ch) ?? 0) + 1);
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    counts().set(ch, Math.max(0, (counts().get(ch) ?? 1) - 1));
    await unlisten();
  };
}

/** Active `listenTeam` subscriptions for a team (tests). */
export const listenerCount = (teamId: string) =>
  counts().get(teamChannel(teamId)) ?? 0;

/** Closes the LISTEN connection (tests, shutdown). */
export async function closeListener(): Promise<void> {
  const l = g.__sendspriteListener;
  g.__sendspriteListener = undefined;
  g.__sendspriteListenerCounts = undefined;
  await l?.end();
}
