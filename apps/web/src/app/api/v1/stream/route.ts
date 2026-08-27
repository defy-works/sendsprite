import { withApiKey } from "@/lib/api-response";
import { teamChangeStream } from "@/lib/sse";

export const dynamic = "force-dynamic";

/** Same feed as the dashboard, for the CLI's `emails tail`. Full keys only. */
export const GET = withApiKey(
  async (req, auth) => teamChangeStream(auth.team.id, req.signal),
  { permission: "full" },
);
