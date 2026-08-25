import { and, count, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { billingUsage, emails, type BillingUsage } from "@/db/schema";
import type { UsageWindow } from "./plans";

/**
 * Statuses that consumed a send. Identical to `ACTIVE` in
 * `services/send-limits.ts` on purpose: the meter and the caps must count the
 * same rows, or a customer gets billed for sends a cap refused.
 */
export const BILLABLE = [
  "queued",
  "scheduled",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
] as const;

/** Emails a team created in `[w.start, w.end)` that count towards usage. */
export async function countSentIn(
  teamId: string,
  w: UsageWindow,
): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(emails)
    .where(
      and(
        eq(emails.teamId, teamId),
        gte(emails.createdAt, w.start),
        lt(emails.createdAt, w.end),
        inArray(emails.status, [...BILLABLE]),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * The metering watermark for a team's period, if one has been written.
 * `periodStart` is the **stored** `team_billing.period_start` — see
 * `meteringPeriodStart` in `./plans` for why it is never the entitlement's.
 */
export async function usageRow(
  teamId: string,
  periodStart: Date,
): Promise<BillingUsage | undefined> {
  const [row] = await db()
    .select()
    .from(billingUsage)
    .where(
      and(
        eq(billingUsage.teamId, teamId),
        eq(billingUsage.periodStart, periodStart),
      ),
    );
  return row;
}
