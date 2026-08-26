"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { loadEnv } from "@/env.schema";
import { requireOwner } from "@/lib/session";
import { requestMeta } from "@/lib/audit";
import { buildQuickCreateUrl } from "@/lib/aws/quick-create";
import { SES_REGIONS } from "@/lib/aws/regions";
import type { Result } from "@/lib/result";
import * as aws from "@/services/aws-connect";
import * as cf from "@/services/cloudflare-connect";
import {
  issueSetupToken,
  revokePendingSetupTokens,
} from "@/services/setup-tokens";
import { updateInstanceSettings } from "@/services/instance-settings";

export type { Result } from "@/lib/result";

/** Server actions are thin: resolve the owner, delegate, revalidate. */
async function actor() {
  const ctx = await requireOwner();
  return { userId: ctx.userId, meta: requestMeta(await headers()) };
}

/** The wizard and the Instance settings tab render the same steps. */
function revalidate() {
  revalidatePath("/setup");
  revalidatePath("/app/settings/instance");
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
  await revokePendingSetupTokens("aws_callback", a.userId);
  const { token } = await issueSetupToken({
    purpose: "aws_callback",
    issuedBy: a.userId,
    region: r,
    ttlMs: 15 * 60_000,
  });
  return {
    ok: true,
    data: {
      url: buildQuickCreateUrl({
        region: r,
        templateUrl: env.CFN_TEMPLATE_URL,
        callbackUrl: `${env.APP_URL}/api/setup/aws/callback`,
        callbackToken: token,
        stackName: "sendsprite-connect",
      }),
    },
  };
}

export async function detectRole(fd: FormData) {
  const a = await actor();
  const r = region(fd.get("region"));
  if (!r) return UNSUPPORTED_REGION;
  const res = await aws.detectInstanceRole(r, a);
  revalidate();
  return res;
}

export async function connectKeys(fd: FormData) {
  const a = await actor();
  const r = region(fd.get("region"));
  if (!r) return UNSUPPORTED_REGION;
  const res = await aws.connectWithKeys(
    {
      accessKeyId: fd.get("accessKeyId"),
      secretAccessKey: fd.get("secretAccessKey"),
      region: r,
    },
    a,
  );
  revalidate();
  return res;
}

export async function requestProduction(fd: FormData) {
  const a = await actor();
  const res = await aws.requestProductionAccess(
    {
      websiteUrl: fd.get("websiteUrl"),
      mailType: fd.get("mailType"),
      useCase: fd.get("useCase"),
      contactEmail: fd.get("contactEmail") || undefined,
    },
    a,
  );
  revalidate();
  return res;
}

export async function refreshAccount() {
  const a = await actor();
  const res = await aws.refreshSesAccount(a);
  revalidate();
  return res;
}

export async function connectCloudflareAction(fd: FormData) {
  const a = await actor();
  const res = await cf.connectCloudflare(String(fd.get("token") ?? ""), a);
  revalidate();
  return res;
}

export async function disconnectAws() {
  const a = await actor();
  const res = await aws.disconnectAws(a);
  revalidate();
  return res;
}

export async function disconnectCloudflareAction() {
  const a = await actor();
  const res = await cf.disconnectCloudflare(a);
  revalidate();
  return res;
}

const SIGNUP_MODES = ["open", "invite", "closed"] as const;
const instanceForm = z.object({
  signupMode: z.enum([...SIGNUP_MODES, "auto"]),
  landingEnabled: z.enum(["on", "off"]),
  retentionDays: z.coerce
    .number({ error: "Retention days must be a number." })
    .int("Retention days must be a whole number.")
    .min(1, "Retention days must be at least 1.")
    .max(3650, "Retention days must be at most 3650."),
});

/** Instance tab: signup mode (`auto` clears the DB override), landing page, retention. */
export async function updateInstanceAction(fd: FormData): Promise<Result> {
  const a = await actor();
  const parsed = instanceForm.safeParse({
    signupMode: fd.get("signupMode"),
    landingEnabled: fd.get("landingEnabled") ?? "off",
    retentionDays: fd.get("retentionDays"),
  });
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  const { signupMode, landingEnabled, retentionDays } = parsed.data;
  await updateInstanceSettings(
    {
      signupMode: signupMode === "auto" ? null : signupMode,
      landingEnabled: landingEnabled === "on",
      retentionDays,
    },
    a,
  );
  revalidatePath("/app/settings/instance");
  return { ok: true, data: undefined };
}

export async function finishSetup(): Promise<Result> {
  const a = await actor();
  await updateInstanceSettings({ setupCompleted: true }, a);
  revalidatePath("/app", "layout");
  return { ok: true, data: undefined };
}
