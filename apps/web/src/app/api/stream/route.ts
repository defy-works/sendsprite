import { requireTeam } from "@/lib/session";
import { teamChangeStream } from "@/lib/sse";

export const dynamic = "force-dynamic";

/** SSE feed of the active team's changes; `useTeamStream` refreshes on it. */
export async function GET(req: Request): Promise<Response> {
  const { team } = await requireTeam();
  return teamChangeStream(team.id, req.signal);
}
