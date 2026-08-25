import { sql } from "drizzle-orm";
import { db } from "@/db";

/** Postgres NOTIFY channel for one team's SSE listeners (Task 11 subscribes). */
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
