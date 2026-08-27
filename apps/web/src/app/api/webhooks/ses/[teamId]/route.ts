import { NextResponse } from "next/server";
import { ConfirmSubscriptionCommand } from "@aws-sdk/client-sns";
import { makeSns } from "@/lib/aws/clients";
import { resolveAwsContext } from "@/lib/aws/credentials";
import { verifySnsMessage } from "@/lib/sns-message";
import { enqueue } from "@/jobs/enqueue";
import { ingestSesEvent } from "@/services/ingest";
import { getTeamAws, updateTeamAws } from "@/services/team-aws";

export const dynamic = "force-dynamic";

/** SNS messages are a few KB; anything near this is not SNS. */
const MAX_BODY_BYTES = 524_288;
const SUBSCRIBE_URL = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//;
const isArn = (v: string | undefined): v is string => !!v?.startsWith("arn:");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Confirm = { arn: string | null } | { error: string; status: number };

/**
 * Confirm via the SDK when AWS is connected: the response is a typed ARN (no
 * XML scraping) and `AuthenticateOnUnsubscribe` makes SNS require a signed
 * request to unsubscribe, so a leaked SubscribeURL/Token cannot be replayed
 * to drop the subscription. When there are no credentials to sign with, or
 * the SDK call fails (a policy without `sns:ConfirmSubscription`, a stale
 * key…), it falls back to GET SubscribeURL (the unauthenticated confirm SNS
 * documents), host-guarded, redirect-free and time-limited: a subscription
 * that never confirms is worse than one without the unsubscribe guard.
 */
async function confirmSubscription(
  teamId: string,
  msg: {
    TopicArn: string;
    Token: string;
    SubscribeURL: string;
  },
): Promise<Confirm> {
  const ctx = await resolveAwsContext(teamId).catch(() => null);
  if (ctx) {
    try {
      const r = await makeSns(ctx).send(
        new ConfirmSubscriptionCommand({
          TopicArn: msg.TopicArn,
          Token: msg.Token,
          AuthenticateOnUnsubscribe: "true",
        }),
      );
      return { arn: isArn(r.SubscriptionArn) ? r.SubscriptionArn : null };
    } catch (e) {
      console.warn(
        "[ses] ConfirmSubscription via the SDK failed; falling back to SubscribeURL:",
        errMsg(e),
      );
    }
  }
  if (!SUBSCRIBE_URL.test(msg.SubscribeURL))
    return { error: "bad_subscribe_url", status: 400 };
  const r = await fetch(msg.SubscribeURL, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return { error: "confirm_failed", status: 502 };
  const arn = /<SubscriptionArn>([^<]+)<\/SubscriptionArn>/.exec(
    await r.text(),
  )?.[1];
  return { arn: isArn(arn) ? arn : null };
}

/**
 * SNS → Sendsprite for one team: verify signature, confirm subscription,
 * ingest events. The path names the team because every tenant subscribes its
 * own AWS account's topic to its own endpoint.
 *
 * Notifications are always acknowledged (200): SNS would otherwise retry a
 * message we can never process, so non-ok outcomes are logged instead.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ teamId: string }> },
) {
  const { teamId } = await params;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES)
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES)
    return NextResponse.json({ error: "too_large" }, { status: 413 });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  let msg;
  try {
    msg = await verifySnsMessage(raw);
  } catch {
    return NextResponse.json({ error: "bad_signature" }, { status: 403 });
  }
  // Two independent checks. The path alone is guessable, and a topic ARN
  // alone says nothing about which tenant the message is for; both must hold.
  const aws = await getTeamAws(teamId);
  if (!aws?.snsTopicArn || msg.TopicArn !== aws.snsTopicArn)
    return NextResponse.json({ error: "unknown_topic" }, { status: 403 });

  if (msg.Type === "SubscriptionConfirmation") {
    const r = await confirmSubscription(teamId, msg);
    if ("error" in r)
      return NextResponse.json({ error: r.error }, { status: r.status });
    // Never replace a real ARN with a sentinel; a later reconnect fills it in.
    if (r.arn)
      await updateTeamAws(teamId, { snsSubscriptionArn: r.arn }, undefined, {
        audit: false,
      });
    else console.warn("[ses] subscription confirmed but no ARN was returned");
    return NextResponse.json({ ok: true });
  }
  if (msg.Type === "UnsubscribeConfirmation") {
    await updateTeamAws(teamId, { snsSubscriptionArn: null }, undefined, {
      audit: false,
    });
    return NextResponse.json({ ok: true });
  }
  let event: unknown;
  try {
    event = JSON.parse(msg.Message);
  } catch {
    console.warn("[ses] notification is not JSON", msg.MessageId);
    return NextResponse.json({ ok: true });
  }
  const r = await ingestSesEvent(teamId, event, msg.MessageId, { enqueue });
  if (!r.ok)
    console.warn("[ses] notification ignored", msg.MessageId, r.reason);
  return NextResponse.json({ ok: true });
}
