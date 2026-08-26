import { registerQueue } from "../boss";
import { Q } from "../queues";
import { db } from "@/db";
import { teamAws } from "@/db/schema";
import { refreshSesAccount } from "@/services/aws-connect";

/**
 * Hourly SES account refresh, once per connected team. Each team is isolated:
 * one tenant's expired keys or revoked policy must not cost every other
 * tenant their refresh. Exported so tests can drive it directly.
 */
export async function runSesRefresh() {
  const rows = await db().select({ teamId: teamAws.teamId }).from(teamAws);
  for (const { teamId } of rows) {
    try {
      const r = await refreshSesAccount(teamId);
      if (!r.ok) console.warn(`[ses] refresh failed for ${teamId}:`, r.error);
    } catch (e) {
      console.warn(
        `[ses] refresh threw for ${teamId}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return rows.length;
}

registerQueue(Q.sesRefreshAccount, () => runSesRefresh(), {
  // retryLimit 0: a failed check is simply retried by the next tick.
  // :17 keeps the GetAccount calls off the top-of-the-hour crowd.
  cron: "17 * * * *",
  queue: { retryLimit: 0 },
});
