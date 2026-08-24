import { NextResponse } from "next/server";
import { ConfirmSubscriptionCommand } from "@aws-sdk/client-sns";
import { makeSns } from "@/lib/aws/clients";
import { resolveAwsContext } from "@/lib/aws/credentials";
import { verifySnsMessage } from "@/lib/sns-message";
import {
  getInstanceSettings,
  updateInstanceSettings,
} from "@/services/instance-settings";

export const dynamic = "force-dynamic";

/** SNS messages are a few KB; anything near this is not SNS. */
const MAX_BODY_BYTES = 524_288;
const SUBSCRIBE_URL = /^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//;
const isArn = (v: string | undefined): v is string => !!v?.startsWith("arn:");

type Confirm = { arn: string | null } | { error: string; status: number };

/**
 * Confirm via the SDK when AWS is connected: the response is a typed ARN (no
 * XML scraping) and `AuthenticateOnUnsubscribe` makes SNS require a signed
 * request to unsubscribe, so a leaked SubscribeURL/Token cannot be replayed
 * to drop the subscription. Only when there are no credentials to sign with
 * does it fall back to GET SubscribeURL (the unauthenticated confirm SNS
 * documents), host-guarded and time-limited.
 */
async function confirmSubscription(msg: {
  TopicArn: string;
  Token: string;
  SubscribeURL: string;
}): Promise<Confirm> {
  const ctx = await resolveAwsContext().catch(() => null);
  if (ctx) {
    const r = await makeSns(ctx).send(
      new ConfirmSubscriptionCommand({
        TopicArn: msg.TopicArn,
        Token: msg.Token,
        AuthenticateOnUnsubscribe: "true",
      }),
    );
    return { arn: isArn(r.SubscriptionArn) ? r.SubscriptionArn : null };
  }
  if (!SUBSCRIBE_URL.test(msg.SubscribeURL))
    return { error: "bad_subscribe_url", status: 400 };
  const r = await fetch(msg.SubscribeURL, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) return { error: "confirm_failed", status: 502 };
  const arn = /<SubscriptionArn>([^<]+)<\/SubscriptionArn>/.exec(
    await r.text(),
  )?.[1];
  return { arn: isArn(arn) ? arn : null };
}

/**
 * SNS → Sendsprite. Phase 2: verify signature, confirm subscription, ack.
 * Phase 3 replaces the Notification branch with event ingestion.
 */
export async function POST(req: Request) {
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
  const settings = await getInstanceSettings();
  if (!settings.snsTopicArn || msg.TopicArn !== settings.snsTopicArn)
    return NextResponse.json({ error: "unknown_topic" }, { status: 403 });

  if (msg.Type === "SubscriptionConfirmation") {
    const r = await confirmSubscription(msg);
    if ("error" in r)
      return NextResponse.json({ error: r.error }, { status: r.status });
    // Never replace a real ARN with a sentinel; a later reconnect fills it in.
    if (r.arn)
      await updateInstanceSettings({ snsSubscriptionArn: r.arn }, undefined, {
        audit: false,
      });
    else console.warn("[ses] subscription confirmed but no ARN was returned");
    return NextResponse.json({ ok: true });
  }
  if (msg.Type === "UnsubscribeConfirmation") {
    await updateInstanceSettings({ snsSubscriptionArn: null }, undefined, {
      audit: false,
    });
    return NextResponse.json({ ok: true });
  }
  console.info("[ses] notification", msg.MessageId); // Phase 3: enqueue ses.ingest
  return NextResponse.json({ ok: true });
}
