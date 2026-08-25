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
});

/**
 * Called once by the CloudFormation custom resource. Auth = one-time token,
 * burned on first use even when the connection then fails (the wizard issues
 * a new one for a retry). A non-2xx makes the Lambda report FAILED, so the
 * stack rolls back and the IAM user is deleted; the failure reason is kept
 * on the token for /status. A subscribe-only problem is a 200 with a warning
 * so a working connection is never rolled back.
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
  const res = await connectWithKeys(
    {
      accessKeyId: parsed.data.accessKeyId,
      secretAccessKey: parsed.data.secretAccessKey,
      region: parsed.data.region,
    },
    { userId: tok.issuedBy },
  );
  if (!res.ok) {
    await recordSetupFailure(tok.id, res.error);
    return NextResponse.json(
      { error: res.error, code: res.code ?? null },
      { status: 502 },
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
