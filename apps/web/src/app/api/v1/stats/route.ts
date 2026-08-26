import { ok, withApiKey } from "@/lib/api-response";
import { teamStats } from "@/services/stats";

export const dynamic = "force-dynamic";

export const GET = withApiKey(
  async (_req, auth) => ok(await teamStats(auth.team.id)),
  { permission: "full" },
);
