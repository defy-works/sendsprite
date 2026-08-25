import { describe, expect, it } from "vitest";
import {
  BillingStateObject,
  FREE_PLAN_METADATA,
  PLANS,
  PlanMetadata,
  SUBSCRIPTION_STATUSES,
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

  it("returns null for an unknown or missing plan instead of throwing", () => {
    expect(planFromProductMetadata({ plan: "enterprise" })).toBeNull();
    expect(planFromProductMetadata({})).toBeNull();
    expect(planFromProductMetadata(undefined)).toBeNull();
    expect(planFromProductMetadata({ plan: "pro" })).toBeNull(); // no included_emails
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
      }).success,
    ).toBe(true);
  });

  it("carries the past-due grace deadline when there is one", () => {
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
});
