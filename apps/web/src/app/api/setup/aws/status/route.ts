import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { resolveTeam } from "@/lib/team";
import { getTeamAws } from "@/services/team-aws";
import { lastSetupFailure, pendingSetupToken } from "@/services/setup-tokens";

export const dynamic = "force-dynamic";

/**
 * Polled by the wizard while the user is in the AWS console, for the caller's
 * active team. Account details are owner/admin-only; other members just learn
 * whether their team is connected.
 */
export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const team = await resolveTeam(
    s.user.id,
    s.session.activeOrganizationId ?? null,
  );
  if (!team) return NextResponse.json({ error: "no_team" }, { status: 403 });
  const [aws, pending] = await Promise.all([
    getTeamAws(team.team.id),
    pendingSetupToken("aws_callback", s.user.id, team.team.id),
  ]);
  const base = {
    connected: aws !== null,
    pendingToken: Boolean(pending),
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
