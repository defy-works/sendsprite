import { describe, expect, it } from "vitest";
import {
  FREE_ENTITLEMENT,
  PAST_DUE_GRACE_MS,
  calendarMonth,
  entitlementFrom,
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

  it("a stale period (now outside it) falls back to the UTC month", () => {
    // A renewal webhook that never arrived must not hand out an empty window,
    // and with it unlimited sending.
    const e = entitlementFrom(
      {
        ...row,
        periodStart: new Date("2026-06-10T00:00:00Z"),
        periodEnd: new Date("2026-07-10T00:00:00Z"),
      },
      NOW,
    );
    expect(e.periodStart).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    expect(e.periodEnd).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(e.plan).toBe("pro");
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

  it("keeps the plan when the clock was never started", () => {
    // Defensive: every past_due row is stamped by the webhook handler, but a
    // row without a stamp must not be silently downgraded.
    expect(
      entitlementFrom({ ...pastDue, pastDueAt: null }, new Date("2027-01-01")),
    ).toMatchObject({ plan: "pro" });
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
    expect(entitlementFrom(stale, NOW).periodStart).toEqual(
      new Date("2026-08-01T00:00:00.000Z"),
    );
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
