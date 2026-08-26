import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { resolveTeam } from "@/lib/team";
import { getTeamAws } from "@/services/team-aws";
import {
  inFlightSetupToken,
  lastSetupFailure,
  pendingSetupToken,
} from "@/services/setup-tokens";

export const dynamic = "force-dynamic";

/**
 * How long a consumed-but-unfinished callback is still believed in.
 *
 * `connectWithKeys` does an STS identity check, a configuration set, an SNS
 * topic, a subscription and an event destination, each against a possibly slow
 * region. Five minutes is far longer than that takes and short enough that a
 * callback whose process died is reported as a failure while the user is still
 * looking at the page.
 */
const IN_FLIGHT_MS = 5 * 60_000;

/**
 * Polled by the wizard while the user is in the AWS console, for the caller's
 * active team. Account details are owner/admin-only; other members just learn
 * whether their team is connected.
 *
 * Three states, not two. `connected` and `pendingToken` alone could not
 * describe the window between AWS calling us back and the provisioning
 * finishing — the token is burnt on the first line of the callback and the
 * connection is not written until the last — so the wizard read that window as
 * an expired link and told the user so, every single time. `inFlight` is that
 * window. See `inFlightSetupToken`.
 */
export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const team = await resolveTeam(
    s.user.id,
    s.session.activeOrganizationId ?? null,
  );
  if (!team) return NextResponse.json({ error: "no_team" }, { status: 403 });
  const [aws, pending, inFlight] = await Promise.all([
    getTeamAws(team.team.id),
    pendingSetupToken("aws_callback", s.user.id, team.team.id),
    inFlightSetupToken("aws_callback", s.user.id, team.team.id, IN_FLIGHT_MS),
  ]);
  const base = {
    connected: aws !== null,
    pendingToken: Boolean(pending),
    /** AWS has called back and we are still creating resources in the account. */
    inFlight: aws === null && inFlight !== null,
    expiresAt: pending?.expiresAt ?? null,
  };
  if (team.role !== "owner" && team.role !== "admin")
    return NextResponse.json(base);
  return NextResponse.json({
    ...base,
    region: aws?.region ?? null,
    accountId: aws?.accountId ?? null,
    status: aws?.sesAccountStatus ?? null,
    lastFailure: await lastSetupFailure(
      "aws_callback",
      s.user.id,
      team.team.id,
    ),
  });
}
