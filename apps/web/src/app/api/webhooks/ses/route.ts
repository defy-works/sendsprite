import { NextResponse } from "next/server";
import { verifySnsMessage } from "@/lib/sns-message";
import {
  getInstanceSettings,
  updateInstanceSettings,
} from "@/services/instance-settings";

export const dynamic = "force-dynamic";

/**
 * SNS → Sendsprite. Phase 2: verify signature, confirm subscription, ack.
 * Phase 3 replaces the Notification branch with event ingestion.
 */
export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = JSON.parse(await req.text());
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
    if (
      !/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?\//.test(
        msg.SubscribeURL,
      )
    )
      return NextResponse.json({ error: "bad_subscribe_url" }, { status: 400 });
    const r = await fetch(msg.SubscribeURL);
    if (!r.ok)
      return NextResponse.json({ error: "confirm_failed" }, { status: 502 });
    const xml = await r.text();
    const arn =
      /<SubscriptionArn>([^<]+)<\/SubscriptionArn>/.exec(xml)?.[1] ??
      "confirmed";
    await updateInstanceSettings({ snsSubscriptionArn: arn }, undefined, {
      audit: false,
    });
    return NextResponse.json({ ok: true });
  }
  if (msg.Type === "Notification") {
    console.info("[ses] notification", msg.MessageId); // Phase 3: enqueue ses.ingest
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: true });
}
