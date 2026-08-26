import { describe, expect, it } from "vitest";
import {
  BillingStateObject,
  FREE_PLAN_METADATA,
  PLANS,
  PlanMetadata,
  SUBSCRIPTION_STATUSES,
  claimsPlanMetadata,
  isEntitledStatus,
  planFromProductMetadata,
} from "../src/index";

describe("plan metadata", () => {
  it("parses the metadata Polar products carry", () => {
    expect(
      planFromProductMetadata({
        plan: "pro",
        included_emails: 50000,
        overage_per_1k_cents: 40,
      }),
    ).toEqual({ plan: "pro", includedEmails: 50000, overagePer1kCents: 40 });
  });

  it("accepts the numbers as strings (Polar metadata values may be text)", () => {
    expect(
      planFromProductMetadata({
        plan: "scale",
        included_emails: "300000",
        overage_per_1k_cents: "25",
      }),
    ).toEqual({ plan: "scale", includedEmails: 300000, overagePer1kCents: 25 });
  });

  it("tolerates whitespace around a numeric string", () => {
    expect(
      planFromProductMetadata({ plan: "pro", included_emails: " 50000 " }),
    ).toEqual({ plan: "pro", includedEmails: 50000, overagePer1kCents: 0 });
  });

  it("returns null for an unknown or missing plan instead of throwing", () => {
    expect(planFromProductMetadata({ plan: "enterprise" })).toBeNull();
    expect(planFromProductMetadata({})).toBeNull();
    expect(planFromProductMetadata(undefined)).toBeNull();
    expect(planFromProductMetadata({ plan: "pro" })).toBeNull(); // no included_emails
  });

  /**
   * The regression that matters most: `z.coerce.number()` is `Number(v)`, and
   * `Number(null) === 0`. Coercing here would persist a paying customer as
   * `plan: "pro", includedEmails: 0` — a plan that is not null, so nothing
   * warns, and every send 429s `monthly_quota_exceeded`. Malformed must be
   * indistinguishable from absent: `null`, never a zero-email plan.
   */
  it("rejects a malformed included_emails rather than coercing it to a number", () => {
    for (const included_emails of [
      null,
      "",
      "   ",
      false,
      true,
      [],
      {},
      "50,000",
      "0x10",
      "1e5",
      "abc",
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(
        planFromProductMetadata({ plan: "pro", included_emails }),
        `included_emails: ${JSON.stringify(included_emails)}`,
      ).toBeNull();
    }
  });

  it("keeps the integer and non-negative bounds on included_emails", () => {
    expect(
      planFromProductMetadata({ plan: "pro", included_emails: -1 }),
    ).toBeNull();
    expect(
      planFromProductMetadata({ plan: "pro", included_emails: "50000.5" }),
    ).toBeNull();
    expect(
      planFromProductMetadata({ plan: "pro", included_emails: 50000.5 }),
    ).toBeNull();
  });

  /**
   * `overage_per_1k_cents` is display-only — whether overage is billed at all
   * is decided by the subscription's metered price, not by this field — so a
   * typo in it degrades to 0 instead of un-planning the customer.
   */
  it("degrades a malformed overage_per_1k_cents to 0 without failing the plan", () => {
    for (const overage_per_1k_cents of [null, "", "40c", -5, {}, false]) {
      expect(
        planFromProductMetadata({
          plan: "pro",
          included_emails: 50000,
          overage_per_1k_cents,
        }),
        `overage_per_1k_cents: ${JSON.stringify(overage_per_1k_cents)}`,
      ).toEqual({ plan: "pro", includedEmails: 50000, overagePer1kCents: 0 });
    }
  });

  it("PLANS is ordered cheapest first and FREE_PLAN_METADATA is the fallback", () => {
    expect(PLANS).toEqual(["free", "pro", "scale"]);
    expect(FREE_PLAN_METADATA).toEqual({
      plan: "free",
      includedEmails: 3000,
      overagePer1kCents: 0,
    });
    expect(PlanMetadata.safeParse(FREE_PLAN_METADATA).success).toBe(true);
  });
});

describe("claimsPlanMetadata", () => {
  it("separates 'not our product' from 'our product, broken'", () => {
    // Ours and well-formed.
    expect(claimsPlanMetadata({ plan: "pro", included_emails: 50000 })).toBe(
      true,
    );
    // Ours but broken — the case a caller must not treat as a downgrade.
    const broken = { plan: "pro", included_emails: null };
    expect(planFromProductMetadata(broken)).toBeNull();
    expect(claimsPlanMetadata(broken)).toBe(true);
    // Not ours.
    expect(claimsPlanMetadata({ plan: "enterprise" })).toBe(false);
    expect(claimsPlanMetadata({})).toBe(false);
    expect(claimsPlanMetadata(undefined)).toBe(false);
    expect(claimsPlanMetadata(null)).toBe(false);
  });
});

describe("subscription status", () => {
  it("entitles active, trialing and past_due; not canceled/unpaid/incomplete", () => {
    expect(SUBSCRIPTION_STATUSES).toContain("past_due");
    for (const s of ["active", "trialing", "past_due"] as const)
      expect(isEntitledStatus(s)).toBe(true);
    for (const s of ["canceled", "unpaid", "incomplete", "paused"] as const)
      expect(isEntitledStatus(s)).toBe(false);
    // An unknown status from a provider we do not model is not entitling.
    expect(isEntitledStatus("something_new")).toBe(false);
  });
});

describe("BillingStateObject", () => {
  it("parses what the dashboard renders", () => {
    expect(
      BillingStateObject.safeParse({
        enabled: true,
        plan: "pro",
        status: "active",
        includedEmails: 50000,
        overagePer1kCents: 40,
        overageEnabled: true,
        cancelAtPeriodEnd: false,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        used: 1234,
        reportedUnits: 1200,
        managed: true,
        pastDueAt: null,
      }).success,
    ).toBe(true);
    // A team that never touched Polar: free plan, nothing managed.
    expect(
      BillingStateObject.safeParse({
        enabled: true,
        plan: "free",
        status: null,
        includedEmails: 3000,
        overagePer1kCents: 0,
        overageEnabled: false,
        cancelAtPeriodEnd: false,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        used: 12,
        reportedUnits: 0,
        managed: false,
        pastDueAt: null,
      }).success,
    ).toBe(true);
  });

  it("carries the past-due stamp when there is one", () => {
    const parsed = BillingStateObject.safeParse({
      enabled: true,
      plan: "pro",
      status: "past_due",
      includedEmails: 50000,
      overagePer1kCents: 40,
      overageEnabled: true,
      cancelAtPeriodEnd: false,
      periodStart: "2026-08-01T00:00:00.000Z",
      periodEnd: "2026-09-01T00:00:00.000Z",
      used: 1234,
      reportedUnits: 1200,
      managed: true,
      pastDueAt: "2026-08-20T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("unreachable");
    expect(parsed.data.pastDueAt).toBe("2026-08-20T00:00:00.000Z");
  });

  it("requires pastDueAt to be stated, like every other nullable field", () => {
    // Two states, not three: a producer says `null` rather than omitting it.
    expect(
      BillingStateObject.safeParse({
        enabled: true,
        plan: "free",
        status: null,
        includedEmails: 3000,
        overagePer1kCents: 0,
        overageEnabled: false,
        cancelAtPeriodEnd: false,
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
        used: 12,
        reportedUnits: 0,
        managed: false,
      }).success,
    ).toBe(false);
  });
});
