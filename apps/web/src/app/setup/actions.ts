"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { loadEnv } from "@/env.schema";
import { requireTeamAdmin } from "@/lib/session";
import { requestMeta } from "@/lib/audit";
import { buildQuickCreateUrl } from "@/lib/aws/quick-create";
import { stackName } from "@/lib/aws/naming";
import { SES_REGIONS } from "@/lib/aws/regions";
import type { Result } from "@/lib/result";
import * as aws from "@/services/aws-connect";
import * as cf from "@/services/cloudflare-connect";
import {
  issueSetupToken,
  revokePendingSetupTokens,
} from "@/services/setup-tokens";
import { setTeamSetupCompleted } from "@/services/team-settings";

export type { Result } from "@/lib/result";

/** Server actions are thin: resolve the team admin, delegate, revalidate. */
async function actor() {
  const ctx = await requireTeamAdmin();
  return {
    userId: ctx.userId,
    teamId: ctx.team.id,
    teamSlug: ctx.team.slug,
    meta: requestMeta(await headers()),
  };
}

/** What the services want: an actor with no team fields attached. */
const who = (a: Awaited<ReturnType<typeof actor>>) => ({
  userId: a.userId,
  meta: a.meta,
});

/** The wizard and the Sending settings tab render the same steps. */
function revalidate() {
  revalidatePath("/setup");
  revalidatePath("/app/settings");
}

const UNSUPPORTED_REGION = {
  ok: false as const,
  error: "Unsupported SES region.",
};
/** The client only offers SES_REGIONS; anything else is a tampered form. */
const region = (v: unknown): string | null =>
  (SES_REGIONS as readonly string[]).includes(String(v)) ? String(v) : null;

/**
 * Issues a one-time callback token and returns the CloudFormation quick-create
 * link; the client opens it. The template's `CallbackUrl` only accepts https,
 * so a plain-http APP_URL (local dev) is refused up front.
 */
export async function startQuickCreate(
  fd: FormData,
): Promise<Result<{ url: string }>> {
  const a = await actor();
  const env = loadEnv();
  if (!env.APP_URL.startsWith("https://"))
    return {
      ok: false,
      error:
        "One-click connect needs a public https APP_URL; use manual keys locally.",
    };
  const r = region(fd.get("region"));
  if (!r) return UNSUPPORTED_REGION;
  await revokePendingSetupTokens("aws_callback", a.userId, a.teamId);
  const { token } = await issueSetupToken({
    purpose: "aws_callback",
    issuedBy: a.userId,
    teamId: a.teamId,
    region: r,
    // Covers the whole flow, not just the click: the owner reads the review
    // page, ticks the IAM checkbox, and then waits out the stack build. At 15
    // minutes a slow read plus a slow build ran out mid-deploy, and an expired
    // token makes the callback 403, which rolls the finished stack back.
    ttlMs: 60 * 60_000,
  });
  return {
    ok: true,
    data: {
      url: buildQuickCreateUrl({
        region: r,
        templateUrl: env.CFN_TEMPLATE_URL,
        callbackUrl: `${env.APP_URL}/api/setup/aws/callback`,
        callbackToken: token,
        // Named after the org: two teams may connect the same AWS account.
        stackName: stackName(a.teamSlug),
      }),
    },
  };
}

/**
 * The way out of "Waiting for CloudFormation…" other than the token expiring.
 *
 * Revokes the caller's pending one-click token so the wizard's status poll
 * stops seeing it and the button unlocks. Only *unconsumed* tokens are
 * touched — `revokePendingSetupTokens` filters on `consumedAt IS NULL` — so
 * once AWS has called back and provisioning is under way there is nothing
 * here to cancel, and the client hides the button for that phase anyway.
 *
 * If a stack is already creating when this runs, its callback presents a
 * token that no longer exists, gets a 4xx, and the template reports FAILED —
 * the stack rolls itself back and deletes the IAM user. That is the same
 * self-healing path an expired link takes; cancelling just does not make the
 * owner wait an hour for it.
 */
export async function cancelQuickCreate(): Promise<Result<void>> {
  const a = await actor();
  await revokePendingSetupTokens("aws_callback", a.userId, a.teamId);
  return { ok: true, data: undefined };
}

export async function connectKeys(fd: FormData) {
  const a = await actor();
  const r = region(fd.get("region"));
  if (!r) return UNSUPPORTED_REGION;
  const res = await aws.connectWithKeys(
    a.teamId,
    a.teamSlug,
    {
      accessKeyId: fd.get("accessKeyId"),
      secretAccessKey: fd.get("secretAccessKey"),
      region: r,
    },
    who(a),
  );
  revalidate();
  return res;
}

export async function requestProduction(fd: FormData) {
  const a = await actor();
  const res = await aws.requestProductionAccess(
    a.teamId,
    {
      websiteUrl: fd.get("websiteUrl"),
      mailType: fd.get("mailType"),
      useCase: fd.get("useCase"),
      contactEmail: fd.get("contactEmail") || undefined,
    },
    who(a),
  );
  revalidate();
  return res;
}

export async function refreshAccount() {
  const a = await actor();
  const res = await aws.refreshSesAccount(a.teamId, who(a));
  revalidate();
  return res;
}

export async function disconnectAws() {
  const a = await actor();
  const res = await aws.disconnectAws(a.teamId, who(a));
  revalidate();
  return res;
}

export async function disconnectCloudflareAction() {
  const a = await actor();
  const res = await cf.disconnectCloudflare(a.teamId, who(a));
  revalidate();
  return res;
}

/** Marks this team's wizard finished; the /app layout gates on it. */
export async function finishSetup(): Promise<Result> {
  const a = await actor();
  await setTeamSetupCompleted(a.teamId);
  revalidatePath("/app", "layout");
  return { ok: true, data: undefined };
}
