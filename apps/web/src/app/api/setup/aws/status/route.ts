import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { resolveTeam } from "@/lib/team";
import { getInstanceSettings } from "@/services/instance-settings";
import { lastSetupFailure, pendingSetupToken } from "@/services/setup-tokens";

export const dynamic = "force-dynamic";

/**
 * Polled by the wizard while the user is in the AWS console. Account details
 * are owner-only; other members just learn whether the instance is connected.
 */
export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const [settings, pending, team] = await Promise.all([
    getInstanceSettings(),
    pendingSetupToken("aws_callback", s.user.id),
    resolveTeam(s.user.id, s.session.activeOrganizationId ?? null),
  ]);
  const base = {
    connected: settings.awsMode !== "none",
    pendingToken: Boolean(pending),
    expiresAt: pending?.expiresAt ?? null,
  };
  if (team?.role !== "owner") return NextResponse.json(base);
  return NextResponse.json({
    ...base,
    awsMode: settings.awsMode,
    accountId: settings.awsAccountId,
    status: settings.sesAccountStatus,
    lastFailure: await lastSetupFailure("aws_callback", s.user.id),
  });
}
