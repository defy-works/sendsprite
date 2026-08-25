import { sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "@/db";

/** Postgres NOTIFY channel for one team's SSE listeners (`listenTeam` subscribes). */
export const teamChannel = (teamId: string) =>
  `ss_team_${teamId.replace(/[^a-zA-Z0-9_]/g, "_")}`;

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
// Lives on globalThis outside production for the same HMR reason as `db()`.
type Listener = ReturnType<typeof postgres>;
const g = globalThis as { __sendspriteListener?: Listener };

function listener(): Listener {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return (g.__sendspriteListener ??= postgres(url, { max: 1 }));
}

/**
 * Subscribe to a team's notifications. Resolves once the LISTEN is active,
 * to an unsubscribe function (the connection stays open for other teams).
 */
export async function listenTeam(
  teamId: string,
  cb: (payload: string) => void,
): Promise<() => Promise<void>> {
  const { unlisten } = await listener().listen(teamChannel(teamId), cb);
  return unlisten;
}

/** Closes the LISTEN connection (tests, shutdown). */
export async function closeListener(): Promise<void> {
  const l = g.__sendspriteListener;
  g.__sendspriteListener = undefined;
  await l?.end();
}
