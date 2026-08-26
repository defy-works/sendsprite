"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { CampaignCounts, CampaignStatus } from "@sendsprite/shared";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Link } from "@/components/ui/Link";
import { useTeamStream } from "@/components/app/useTeamStream";
import {
  CAMPAIGN_STATS,
  STATUS_PLAN,
  campaignLogHref,
  formatCount,
  rate,
} from "../send";

/**
 * What actually happened, derived rather than tallied.
 *
 * The numbers come from `campaignCounts`, one scan of this campaign's rows in
 * `emails` — never an incremented counter, because SES delivery is explicitly
 * at-least-once and a counter drifts the first time a webhook retries. The
 * labels and their one-line notes live in `send.ts`; two of them exist because
 * the obvious label would be a lie:
 *
 * - `sent` is "queued to SES", not "delivered". It counts recipients this
 *   campaign handed over, which is the whole audience once queueing finishes
 *   and says nothing about whether anyone received it.
 * - `opened` and `clicked` count **recipients**, not events, so `opened / sent`
 *   is an open rate rather than a hit count.
 *
 * A cancelled campaign keeps every number. `cancelCampaign` deliberately
 * leaves `counts` standing, and the panel has to as well: those recipients
 * were mailed, their events keep arriving for a while afterwards, and a panel
 * that blanked them would let somebody believe cancelling recalled the mail.
 */
export function StatsPanel({
  campaignId,
  status,
  counts,
}: {
  campaignId: string;
  status: CampaignStatus;
  counts: CampaignCounts;
}) {
  const plan = STATUS_PLAN[status];
  const href = campaignLogHref(campaignId);

  return (
    <Card>
      {plan.live && <Live sending={status === "sending"} />}
      <CardHeader>
        <CardTitle>Results</CardTitle>
        <Link
          href={href}
          className="text-xs text-white/60 no-underline hover:text-white"
        >
          Mail log →
        </Link>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        {status === "cancelled" && (
          <p className="text-sm text-amber-300">
            This campaign was stopped part-way. Everything below is mail that
            did go out before it stopped — it could not be recalled, and its
            delivery and open numbers keep rising for a while yet.
          </p>
        )}
        {status === "sending" && (
          <p className="text-sm text-white/60">
            Still sending. These numbers refresh on their own as recipients are
            queued and events land.
          </p>
        )}

        {/* A grid of links rather than a description list: each tile is one
            anchor, and `dt`/`dd` may not live inside one. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {CAMPAIGN_STATS.map((s) => {
            const value = counts[s.key];
            const pct = s.rateOf ? rate(value, counts[s.rateOf]) : null;
            return (
              <Link
                key={s.key}
                href={href}
                className="flex flex-col gap-1 rounded-lg border border-white/8 bg-white/2 p-3 no-underline hover:border-white/20"
              >
                <span className="text-[11px] tracking-wide text-white/45 uppercase">
                  {s.label}
                </span>
                <span className="flex items-baseline gap-2">
                  <span className="text-2xl font-medium tabular-nums">
                    {formatCount(value)}
                  </span>
                  {pct && (
                    <span className="text-xs text-white/45 tabular-nums">
                      {pct}
                    </span>
                  )}
                </span>
                <span className="text-[11px] leading-snug text-white/40">
                  {s.note}
                </span>
              </Link>
            );
          })}
        </div>

        <p className="text-xs text-white/45">
          Every number opens this campaign&rsquo;s mail log, where you can
          narrow by status or recipient. Percentages are of the recipients this
          campaign queued, and opens and clicks count people rather than events
          — one recipient opening six times is one open.
        </p>
      </CardBody>
    </Card>
  );
}

/**
 * Keeps a moving campaign's numbers moving.
 *
 * Two sources, because neither alone is enough. The team's SSE feed covers
 * every event that lands for a message (`recordEvent` notifies the team), which
 * is most of what changes here; the slow poll covers the rest — the fan-out
 * materialising the next chunk, and a campaign that a paused cap has left
 * quietly waiting. Fifteen seconds is far below the tick that moves it and far
 * above anything that could be called polling pressure.
 */
function Live({ sending }: { sending: boolean }) {
  const router = useRouter();
  useTeamStream();
  useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [router, sending]);
  return null;
}
