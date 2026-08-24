import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getInstanceSettings } from "@/services/instance-settings";
import { pendingSetupToken } from "@/services/setup-tokens";

export const dynamic = "force-dynamic";

/** Polled by the wizard while the user is in the AWS console. */
export async function GET() {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const settings = await getInstanceSettings();
  const pending = await pendingSetupToken("aws_callback", s.user.id);
  return NextResponse.json({
    connected: settings.awsMode !== "none",
    awsMode: settings.awsMode,
    accountId: settings.awsAccountId,
    status: settings.sesAccountStatus,
    pendingToken: Boolean(pending),
    expiresAt: pending?.expiresAt ?? null,
  });
}
