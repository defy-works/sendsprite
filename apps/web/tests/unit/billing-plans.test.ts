import { describe, expect, it } from "vitest";
import type { TeamBilling } from "@/db/schema";
import {
  FREE_ENTITLEMENT,
  PAST_DUE_GRACE_MS,
  calendarMonth,
  entitlementFrom,
  hasEntitlingSubscription,
  meteringPeriodStart,
  orderIsNewer,
  type BillingSnapshot,
} from "@/services/billing/plans";

const NOW = new Date("2026-08-25T12:00:00Z");

const row: BillingSnapshot = {
  plan: "pro",
  status: "active",
  includedEmails: 50000,
  overagePer1kCents: 40,
  overageEnabled: true,
  cancelAtPeriodEnd: false,
  periodStart: new Date("2026-08-10T00:00:00Z"),
  periodEnd: new Date("2026-09-10T00:00:00Z"),
  pastDueAt: null,
};

describe("calendarMonth", () => {
  it("is the UTC month containing `now`, half-open", () => {
    expect(calendarMonth(NOW)).toEqual({
      start: new Date("2026-08-01T00:00:00.000Z"),
      end: new Date("2026-09-01T00:00:00.000Z"),
    });
    expect(calendarMonth(new Date("2026-12-31T23:59:59Z")).end).toEqual(
      new Date("2027-01-01T00:00:00.000Z"),
    );
  });
});

describe("entitlementFrom", () => {
  it("no row: free, hard-capped at 3 000 over the UTC month", () => {
    expect(entitlementFrom(undefined, NOW)).toEqual(FREE_ENTITLEMENT(NOW));
    expect(FREE_ENTITLEMENT(NOW)).toMatchObject({
      plan: "free",
      monthlyCap: 3000,
      overageEnabled: false,
      managed: false,
      status: null,
      pastDueAt: null,
    });
  });

  it("an entitled subscription with a metered price has no monthly cap", () => {
    const e = entitlementFrom(row, NOW);
    expect(e).toMatchObject({
      plan: "pro",
      includedEmails: 50000,
      monthlyCap: null,
      overageEnabled: true,
      managed: true,
    });
    expect(e.periodStart).toEqual(row.periodStart);
    expect(e.periodEnd).toEqual(row.periodEnd);
  });

  it("without a metered price the include becomes a hard cap", () => {
    expect(
      entitlementFrom({ ...row, overageEnabled: false }, NOW).monthlyCap,
    ).toBe(50000);
  });

  it("past_due keeps the plan; canceled and unpaid fall back to free", () => {
    expect(entitlementFrom({ ...row, status: "past_due" }, NOW).plan).toBe(
      "pro",
    );
    for (const status of ["canceled", "unpaid", "incomplete"])
      expect(entitlementFrom({ ...row, status }, NOW)).toMatchObject({
        plan: "free",
        monthlyCap: 3000,
        managed: true,
      });
  });

  it("a stale period rolls forward on its own anniversary", () => {
    // A renewal webhook that has not landed must not hand out an empty window,
    // and with it unlimited sending — but jumping to the calendar month would
    // re-count sends already consumed against the previous allowance and 429 a
    // customer who has just paid.
    const e = entitlementFrom(
      {
        ...row,
        periodStart: new Date("2026-06-10T09:30:00Z"),
        periodEnd: new Date("2026-07-10T09:30:00Z"),
      },
      NOW,
    );
    expect(e.periodStart).toEqual(new Date("2026-08-09T09:30:00.000Z"));
    expect(e.periodEnd).toEqual(new Date("2026-09-08T09:30:00.000Z"));
    expect(e.periodStart.getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(e.periodEnd.getTime()).toBeGreaterThan(NOW.getTime());
    expect(e.plan).toBe("pro");
  });

  it("rolls backwards for a period that has not started yet", () => {
    const e = entitlementFrom(
      {
        ...row,
        periodStart: new Date("2026-09-10T00:00:00Z"),
        periodEnd: new Date("2026-10-10T00:00:00Z"),
      },
      NOW,
    );
    expect(e.periodStart).toEqual(new Date("2026-08-11T00:00:00.000Z"));
    expect(e.periodEnd).toEqual(new Date("2026-09-10T00:00:00.000Z"));
  });

  it("falls back to the calendar month for a period of no length", () => {
    const at = new Date("2026-06-10T00:00:00Z");
    const e = entitlementFrom({ ...row, periodStart: at, periodEnd: at }, NOW);
    expect(e.periodStart).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(e.periodEnd).toEqual(new Date("2026-09-01T00:00:00.000Z"));
  });

  it("ends entitlement once a cancelled period is over", () => {
    // The provider keeps `status: "active"` with `cancelAtPeriodEnd` until the
    // boundary, and the revoke webhook can be lost, dropped as stale, or land
    // while the team is unknown. Without this the roll-forward above would
    // hand a churned customer a fresh allowance every period, for ever.
    const cancelled = { ...row, cancelAtPeriodEnd: true };
    // Before the boundary the paid caps still stand — they are paid for.
    expect(
      entitlementFrom(cancelled, new Date("2026-09-09T23:59:59Z")),
    ).toMatchObject({ plan: "pro", monthlyCap: null });
    expect(
      entitlementFrom(cancelled, new Date("2026-09-10T00:00:00Z")),
    ).toMatchObject({
      plan: "free",
      includedEmails: 3000,
      monthlyCap: 3000,
      status: "active",
      cancelAtPeriodEnd: true,
      managed: true,
    });
    // A year later it is still free, not re-entitled by a rolled window.
    expect(
      entitlementFrom(cancelled, new Date("2027-09-10T00:00:00Z")).plan,
    ).toBe("free");
  });
});

describe("entitlementFrom past-due grace", () => {
  const dueAt = new Date("2026-08-20T00:00:00Z");
  const pastDue: BillingSnapshot = {
    ...row,
    status: "past_due",
    pastDueAt: dueAt,
  };

  it("keeps the paid caps inside the seven-day window", () => {
    expect(PAST_DUE_GRACE_MS).toBe(7 * 24 * 3600 * 1000);
    const e = entitlementFrom(
      pastDue,
      new Date(dueAt.getTime() + PAST_DUE_GRACE_MS - 1),
    );
    expect(e).toMatchObject({
      plan: "pro",
      includedEmails: 50000,
      monthlyCap: null,
      status: "past_due",
      managed: true,
    });
    expect(e.pastDueAt).toEqual(dueAt);
  });

  it("drops to the free caps once the window has passed", () => {
    const e = entitlementFrom(
      pastDue,
      new Date(dueAt.getTime() + PAST_DUE_GRACE_MS),
    );
    expect(e).toMatchObject({
      plan: "free",
      includedEmails: 3000,
      monthlyCap: 3000,
      overageEnabled: false,
      // The status is still what the provider says, and the row is still
      // managed: the dashboard has to offer the portal so the card can be fixed.
      status: "past_due",
      managed: true,
    });
    // The deadline is carried through so the banner can name it.
    expect(e.pastDueAt).toEqual(dueAt);
  });

  it("runs the clock from the period end when there is no stamp", () => {
    // A row can sit at `past_due` with no stamp: `order.paid` clears
    // `pastDueAt` without touching `status`. Treating that as a clock that
    // never starts would let a dead card send for ever.
    const unstamped = { ...pastDue, pastDueAt: null };
    // `periodEnd` is 2026-09-10; the grace runs to the 17th.
    expect(
      entitlementFrom(unstamped, new Date("2026-09-16T00:00:00Z")).plan,
    ).toBe("pro");
    expect(
      entitlementFrom(unstamped, new Date("2026-09-17T00:00:00Z")),
    ).toMatchObject({ plan: "free", monthlyCap: 3000, status: "past_due" });
    expect(
      entitlementFrom(unstamped, new Date("2027-01-01T00:00:00Z")).plan,
    ).toBe("free");
  });

  it("carries pastDueAt onto a non-entitling row", () => {
    expect(
      entitlementFrom({ ...pastDue, status: "unpaid" }, NOW).pastDueAt,
    ).toEqual(dueAt);
  });
});

describe("meteringPeriodStart", () => {
  it("is the stored period start, never the entitlement's window", () => {
    // The calendar-month substitution is an entitlement-only concept: keying
    // usage off it would re-bucket a period halfway through and double-count.
    const stale = {
      ...row,
      periodStart: new Date("2026-06-10T00:00:00Z"),
      periodEnd: new Date("2026-07-10T00:00:00Z"),
    };
    // The entitlement window has rolled forward off the stored start...
    expect(entitlementFrom(stale, NOW).periodStart).toEqual(
      new Date("2026-08-09T00:00:00.000Z"),
    );
    // ...and the metering key has not moved with it.
    expect(meteringPeriodStart(stale, NOW)).toEqual(stale.periodStart);
  });

  it("falls back to the UTC month for a team with no subscription", () => {
    expect(meteringPeriodStart(undefined, NOW)).toEqual(
      new Date("2026-08-01T00:00:00.000Z"),
    );
  });
});

describe("orderIsNewer", () => {
  const paidAt = new Date("2026-08-14T00:00:00Z");

  it("clears the clock for the first order ever seen", () => {
    expect(orderIsNewer(paidAt, null)).toBe(true);
  });

  it("clears it for an order after the last one applied", () => {
    expect(orderIsNewer(paidAt, new Date("2026-07-14T00:00:00Z"))).toBe(true);
  });

  it("refuses a replay of the same or an older invoice", () => {
    // The case the fake cannot stage: a late `order.paid` for last month's
    // invoice, arriving after the subscription has gone past due again.
    expect(orderIsNewer(paidAt, paidAt)).toBe(false);
    expect(orderIsNewer(paidAt, new Date("2026-09-14T00:00:00Z"))).toBe(false);
  });

  it("refuses an unusable timestamp", () => {
    expect(orderIsNewer(new Date("nope"), null)).toBe(false);
  });
});

describe("hasEntitlingSubscription", () => {
  // The predicate `startCheckout` refuses on and the billing page hides its
  // plan buttons on. The two must never disagree — an offered button that can
  // only error, or a hidden one for a team that could have bought.
  const sub = (
    over: Partial<Pick<TeamBilling, "subscriptionId" | "status">> = {},
  ) => ({ subscriptionId: "sub_1", status: "active", ...over });

  it("is false with no row at all", () => {
    expect(hasEntitlingSubscription(undefined)).toBe(false);
  });

  it("is true for every status that keeps the paid entitlement", () => {
    for (const status of ["active", "trialing", "past_due"])
      expect(hasEntitlingSubscription(sub({ status }))).toBe(true);
  });

  it("is false for a row whose subscription no longer entitles", () => {
    // Still `managed` — the portal opens — but there is nothing for a new
    // checkout to collide with, so this team may buy again.
    for (const status of ["canceled", "unpaid", "incomplete", null])
      expect(hasEntitlingSubscription(sub({ status }))).toBe(false);
  });

  it("is false for a row that never carried a subscription id", () => {
    expect(hasEntitlingSubscription(sub({ subscriptionId: null }))).toBe(false);
  });
});
