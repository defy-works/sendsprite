import { NextResponse } from "next/server";
import { z } from "zod";
import { SES_REGIONS } from "@/lib/aws/regions";
import { consumeSetupToken, recordSetupFailure } from "@/services/setup-tokens";
import { connectWithKeys } from "@/services/aws-connect";

export const dynamic = "force-dynamic";
const body = z.object({
  token: z.string().min(40),
  accessKeyId: z.string().min(16).max(128),
  secretAccessKey: z.string().min(16).max(128),
  region: z.enum(SES_REGIONS),
  accountId: z.string().optional(),
  // Both or neither: no template version sends one without the other, and
  // half a teardown reference is worth nothing.
  stackId: z.string().startsWith("arn:aws:cloudformation:").optional(),
  serviceRoleArn: z.string().startsWith("arn:aws:iam::").optional(),
});

/**
 * Called once by the CloudFormation custom resource. Auth = one-time token,
 * burned on first use even when the connection then fails (the wizard issues
 * a new one for a retry). A non-2xx makes the Lambda report FAILED, so the
 * stack rolls back and the IAM user is deleted; the failure reason is kept
 * on the token for /status. A subscribe-only problem is a 200 with a warning
 * so a working connection is never rolled back. A stack created while AWS
 * is already connected is refused with 409 (the live connection is never
 * replaced silently); the token is consumed all the same.
 */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const tok = await consumeSetupToken("aws_callback", parsed.data.token);
  if (!tok)
    return NextResponse.json({ error: "invalid_token" }, { status: 403 });
  if (tok.region !== parsed.data.region) {
    await recordSetupFailure(
      tok.id,
      `Stack was created in ${parsed.data.region} but ${tok.region} was selected.`,
    );
    return NextResponse.json({ error: "region_mismatch" }, { status: 400 });
  }
  // The team comes off the token, never off the request: a stack created for
  // one team must not be able to connect into another.
  const res = await connectWithKeys(
    tok.teamId,
    tok.teamSlug,
    {
      accessKeyId: parsed.data.accessKeyId,
      secretAccessKey: parsed.data.secretAccessKey,
      region: parsed.data.region,
    },
    { userId: tok.issuedBy },
    parsed.data.stackId && parsed.data.serviceRoleArn
      ? {
          stackId: parsed.data.stackId,
          serviceRoleArn: parsed.data.serviceRoleArn,
        }
      : undefined,
  );
  if (!res.ok) {
    await recordSetupFailure(tok.id, res.error);
    return NextResponse.json(
      { error: res.error, code: res.code ?? null },
      { status: res.code === "ALREADY_CONNECTED" ? 409 : 502 },
    );
  }
  // Only the Lambda sees this response; keep a server-side trace of it.
  if (res.data.warning)
    console.warn(
      "setup/aws/callback: connected with warning:",
      res.data.warning,
    );
  return NextResponse.json({ ok: true, warning: res.data.warning ?? null });
}
