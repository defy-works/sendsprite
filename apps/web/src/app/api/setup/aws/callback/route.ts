import { NextResponse } from "next/server";
import { z } from "zod";
import { consumeSetupToken } from "@/services/setup-tokens";
import { connectWithKeys } from "@/services/aws-connect";

export const dynamic = "force-dynamic";
const body = z.object({
  token: z.string().min(20),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  region: z.string(),
  accountId: z.string().optional(),
});

/**
 * Called once by the CloudFormation custom resource. Auth = one-time token.
 * A non-2xx makes the Lambda report FAILED, so the stack rolls back and the
 * IAM user is deleted.
 */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const tok = await consumeSetupToken("aws_callback", parsed.data.token);
  if (!tok)
    return NextResponse.json({ error: "invalid_token" }, { status: 403 });
  if (tok.region !== parsed.data.region)
    return NextResponse.json({ error: "region_mismatch" }, { status: 400 });
  const res = await connectWithKeys(
    {
      accessKeyId: parsed.data.accessKeyId,
      secretAccessKey: parsed.data.secretAccessKey,
      region: parsed.data.region,
    },
    { userId: tok.issuedBy },
  );
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 502 });
  return NextResponse.json({ ok: true });
}
