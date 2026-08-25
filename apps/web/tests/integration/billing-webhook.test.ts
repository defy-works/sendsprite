import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";
import { createFakeProvider, type FakeProvider } from "@/services/billing/fake";
import type {
  BillingProvider,
  ProviderEvent,
} from "@/services/billing/provider";

let pg: Awaited<ReturnType<typeof startPg>>;
let provider: FakeProvider;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_URL = "http://localhost:3000";
  process.env.BILLING_ENABLED = "1";
  process.env.BILLING_PROVIDER = "fake";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
  provider = createFakeProvider();
});
afterAll(async () => {
  await pg.stop();
  delete process.env.BILLING_ENABLED;
  delete process.env.BILLING_PROVIDER;
});

const AUG = new Date("2026-08-01T00:00:00Z");
const SEP = new Date("2026-09-01T00:00:00Z");

/**
 * The fake, with one hand-made verified event. Some shapes cannot be staged
 * through a signed payload — an order replayed from *before* the last one
 * applied (the fake stamps every order with `now`), or a normalised
 * subscription the fake would never emit — and a test that leaned on the
 * fake's current permissiveness to produce them would start passing for the
 * wrong reason the moment the fake is tightened.
 */
const withEvent = (event: ProviderEvent): BillingProvider => ({
  ...provider,
  verifyWebhook: () => ({ ok: true, event }),
});

const NO_HEADERS = new Headers();

describe("handleProviderEvent", () => {
  it("applies subscription.created and resolves the plan from product metadata", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_a",
      externalCustomerId: team.id,
      productId: "prod_pro",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
      modifiedAt: AUG,
    });
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({ status: 200, applied: true });
    const row = (await billingRow(team.id))!;
    expect(row).toMatchObject({
      plan: "pro",
      status: "active",
      includedEmails: 50000,
      overagePer1kCents: 40,
      overageEnabled: true,
      subscriptionId: "sub_a",
      provider: "fake",
      pastDueAt: null,
      lastOrderPaidAt: null,
    });
    expect(row.periodEnd.toISOString()).toBe(SEP.toISOString());
  });

  it("records the delivery as applied and audits the change", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { auditLog, billingEvents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_audit",
      externalCustomerId: team.id,
      productId: "prod_pro",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
      deliveryId: "aud_1",
    });
    await handleProviderEvent(provider, e.body, e.headers);
    const [event] = await db()
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.id, "aud_1"));
    expect(event).toMatchObject({
      teamId: team.id,
      type: "subscription.created",
      objectId: "sub_audit",
      skippedReason: null,
      payload: { type: "subscription.created" },
    });
    expect(event!.appliedAt).not.toBeNull();
    const audits = await db()
      .select()
      .from(auditLog)
      .where(eq(auditLog.teamId, team.id));
    expect(audits.map((a) => a.action)).toContain(
      "billing.subscription.created",
    );
  });

  it("is idempotent: the same delivery id twice applies once", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { billingEvents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_b",
      externalCustomerId: team.id,
      productId: "prod_scale",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
      deliveryId: "dup_1",
    });
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({ applied: true });
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({ status: 200, applied: false, duplicate: true });
    expect(
      await db()
        .select()
        .from(billingEvents)
        .where(eq(billingEvents.id, "dup_1")),
    ).toHaveLength(1);
  });

  it("drops an update whose payload is older than what is stored", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const newer = provider.signSubscriptionEvent("subscription.updated", {
      subscriptionId: "sub_c",
      externalCustomerId: team.id,
      productId: "prod_scale",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
      modifiedAt: new Date("2026-08-20T00:00:00Z"),
    });
    await handleProviderEvent(provider, newer.body, newer.headers);
    const older = provider.signSubscriptionEvent("subscription.updated", {
      subscriptionId: "sub_c",
      externalCustomerId: team.id,
      productId: "prod_pro",
      status: "past_due",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
      modifiedAt: new Date("2026-08-10T00:00:00Z"),
    });
    expect(
      await handleProviderEvent(provider, older.body, older.headers),
    ).toMatchObject({ status: 200, applied: false, reason: "stale" });
    expect((await billingRow(team.id))!.plan).toBe("scale");
  });

  it("past_due keeps the plan and stamps pastDueAt; revoked ends entitlement", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow, entitlementFrom } =
      await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const base = {
      subscriptionId: "sub_d",
      externalCustomerId: team.id,
      productId: "prod_pro",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
    };
    const a = provider.signSubscriptionEvent("subscription.created", {
      ...base,
      status: "active",
      modifiedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await handleProviderEvent(provider, a.body, a.headers, AUG);
    const b = provider.signSubscriptionEvent("subscription.updated", {
      ...base,
      status: "past_due",
      modifiedAt: new Date("2026-08-05T00:00:00Z"),
    });
    await handleProviderEvent(
      provider,
      b.body,
      b.headers,
      new Date("2026-08-12T00:00:00Z"),
    );
    const due = (await billingRow(team.id))!;
    expect(due.status).toBe("past_due");
    expect(due.pastDueAt).toEqual(new Date("2026-08-12T00:00:00Z"));
    expect(entitlementFrom(due, new Date("2026-08-15T00:00:00Z")).plan).toBe(
      "pro",
    );
    // Seven days on, the same row resolves to the free caps (amendment A).
    expect(
      entitlementFrom(due, new Date("2026-08-20T00:00:00Z")),
    ).toMatchObject({ plan: "free", monthlyCap: 3000, status: "past_due" });
    const c = provider.signSubscriptionEvent("subscription.revoked", {
      ...base,
      status: "canceled",
      modifiedAt: new Date("2026-08-09T00:00:00Z"),
    });
    await handleProviderEvent(provider, c.body, c.headers);
    expect(
      entitlementFrom(
        (await billingRow(team.id))!,
        new Date("2026-08-15T00:00:00Z"),
      ),
    ).toMatchObject({ plan: "free", monthlyCap: 3000, managed: true });
  });

  it("keeps the plan fields but applies the status when metadata is malformed", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { db } = await import("@/db");
    const { billingEvents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    const base = {
      subscriptionId: "sub_h",
      externalCustomerId: team.id,
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
    };
    const good = provider.signSubscriptionEvent("subscription.created", {
      ...base,
      status: "active",
      productId: "prod_pro",
      modifiedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await handleProviderEvent(provider, good.body, good.headers);
    // `prod_broken` claims `plan: "pro"` with an unusable `included_emails` —
    // a dashboard fat-finger, not a product we do not sell.
    const broken = provider.signSubscriptionEvent("subscription.updated", {
      ...base,
      status: "past_due",
      productId: "prod_broken",
      modifiedAt: new Date("2026-08-06T00:00:00Z"),
      deliveryId: "half_1",
    });
    expect(
      await handleProviderEvent(
        provider,
        broken.body,
        broken.headers,
        new Date("2026-08-06T00:00:00Z"),
      ),
    ).toMatchObject({
      status: 200,
      applied: true,
      reason: "malformed_plan_metadata_status_only",
    });
    const row = (await billingRow(team.id))!;
    // The plan half is withheld...
    expect(row).toMatchObject({ plan: "pro", includedEmails: 50000 });
    // ...and the status half applied.
    expect(row).toMatchObject({
      status: "past_due",
      productId: "prod_broken",
    });
    expect(row.providerModifiedAt).toEqual(new Date("2026-08-06T00:00:00Z"));
    expect(row.pastDueAt).toEqual(new Date("2026-08-06T00:00:00Z"));
    // Half-applied is neither applied nor skipped: the delivery says so.
    const [event] = await db()
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.id, "half_1"));
    expect(event!.appliedAt).not.toBeNull();
    expect(event!.skippedReason).toBe("malformed_plan_metadata_status_only");
  });

  it("ends the entitlement when a revoked subscription's product is broken", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow, entitlementFrom } =
      await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const base = {
      subscriptionId: "sub_revoke_broken",
      externalCustomerId: team.id,
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
    };
    const good = provider.signSubscriptionEvent("subscription.created", {
      ...base,
      status: "active",
      productId: "prod_pro",
      modifiedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await handleProviderEvent(provider, good.body, good.headers);
    // The customer churns while the product's metadata is broken. Dropping
    // this delivery would leave them on paid caps indefinitely.
    const revoked = provider.signSubscriptionEvent("subscription.revoked", {
      ...base,
      status: "canceled",
      productId: "prod_broken",
      modifiedAt: new Date("2026-08-07T00:00:00Z"),
    });
    expect(
      await handleProviderEvent(provider, revoked.body, revoked.headers),
    ).toMatchObject({ applied: true });
    const row = (await billingRow(team.id))!;
    expect(row.status).toBe("canceled");
    // The stored allowance is still Pro's — nothing was downgraded on the
    // strength of a bad string — but it no longer entitles anything.
    expect(row.includedEmails).toBe(50000);
    expect(
      entitlementFrom(row, new Date("2026-08-15T00:00:00Z")),
    ).toMatchObject({
      plan: "free",
      includedEmails: 3000,
      monthlyCap: 3000,
      managed: true,
    });
  });

  it("writes nothing for a first subscription on a broken product", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    // No stored row to keep the plan fields from, and `included_emails` has no
    // default: there is no honest row to write.
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_first_broken",
      externalCustomerId: team.id,
      productId: "prod_broken",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
    });
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({
      status: 200,
      applied: false,
      reason: "malformed_plan_metadata",
    });
    expect(await billingRow(team.id)).toBeUndefined();
  });

  it("treats a product that is not ours as free", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_i",
      externalCustomerId: team.id,
      productId: "prod_bespoke",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
    });
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({ applied: true });
    expect((await billingRow(team.id))!).toMatchObject({
      plan: "free",
      includedEmails: 3000,
      productId: "prod_bespoke",
    });
  });

  it("records but does not apply an event naming an unknown team", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_e",
      externalCustomerId: "org_does_not_exist",
      productId: "prod_pro",
      status: "active",
    });
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({ status: 200, applied: false, reason: "unknown_team" });
  });

  it("rejects a bad signature with 403 and records nothing", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { billingEvents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_f",
      externalCustomerId: "org_x",
      productId: "prod_pro",
      status: "active",
      deliveryId: "bad_1",
    });
    expect(
      (await handleProviderEvent(provider, `${e.body} `, e.headers)).status,
    ).toBe(403);
    expect(
      await db()
        .select()
        .from(billingEvents)
        .where(eq(billingEvents.id, "bad_1")),
    ).toHaveLength(0);
  });

  it("clears pastDueAt on order.paid", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const a = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_g",
      externalCustomerId: team.id,
      productId: "prod_pro",
      status: "past_due",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
    });
    await handleProviderEvent(provider, a.body, a.headers);
    expect((await billingRow(team.id))!.pastDueAt).not.toBeNull();
    const b = provider.signOrderPaidEvent({
      subscriptionId: "sub_g",
      externalCustomerId: team.id,
    });
    expect(
      await handleProviderEvent(provider, b.body, b.headers),
    ).toMatchObject({ applied: true });
    const row = (await billingRow(team.id))!;
    expect(row.pastDueAt).toBeNull();
    // The watermark the replay guard reads is stamped with the order.
    expect(row.lastOrderPaidAt).not.toBeNull();
  });

  it("a replayed older order.paid does not reset the grace clock", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { team } = await seedTeamWithKey();
    const base = {
      subscriptionId: "sub_j",
      externalCustomerId: team.id,
      productId: "prod_pro",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
    };
    const a = provider.signSubscriptionEvent("subscription.created", {
      ...base,
      status: "past_due",
      modifiedAt: new Date("2026-08-02T00:00:00Z"),
    });
    await handleProviderEvent(provider, a.body, a.headers, AUG);
    const paid = provider.signOrderPaidEvent({
      subscriptionId: "sub_j",
      externalCustomerId: team.id,
    });
    await handleProviderEvent(provider, paid.body, paid.headers);
    expect((await billingRow(team.id))!.pastDueAt).toBeNull();
    // The card fails again a week later.
    const b = provider.signSubscriptionEvent("subscription.updated", {
      ...base,
      status: "past_due",
      modifiedAt: new Date("2026-08-10T00:00:00Z"),
    });
    const dueAgain = new Date("2026-08-10T00:00:00Z");
    await handleProviderEvent(provider, b.body, b.headers, dueAgain);
    expect((await billingRow(team.id))!.pastDueAt).toEqual(dueAgain);
    // A late redelivery of the *older* invoice must not buy another week. The
    // fake stamps every order it signs with `now`, so the replay is staged as
    // a hand-made event.
    const replay = withEvent({
      kind: "order_paid",
      deliveryId: "replay_1",
      type: "order.paid",
      subscriptionId: "sub_j",
      externalCustomerId: team.id,
      paidAt: new Date("2026-08-03T00:00:00Z"),
    });
    expect(await handleProviderEvent(replay, "{}", NO_HEADERS)).toMatchObject({
      status: 200,
      applied: false,
      reason: "stale",
    });
    expect((await billingRow(team.id))!.pastDueAt).toEqual(dueAgain);
  });

  it("records an unmodelled type as ignored", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { billingEvents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const e = provider.signRaw(
      JSON.stringify({ type: "benefit.created", data: {} }),
      "ign_1",
    );
    expect(
      await handleProviderEvent(provider, e.body, e.headers),
    ).toMatchObject({ status: 200, applied: false, reason: "unmodelled_type" });
    const [row] = await db()
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.id, "ign_1"));
    expect(row).toMatchObject({
      appliedAt: null,
      skippedReason: "unmodelled_type",
      teamId: null,
    });
  });

  it("skips a subscription payload it cannot use, and records why", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { db } = await import("@/db");
    const { billingEvents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    // A provider that trusts a payload's shape can normalise an empty object
    // into this. Written straight through it is a `RangeError` from the
    // timestamp encoder mid-transaction, not a refusal anyone can read.
    const r = await handleProviderEvent(
      withEvent({
        kind: "subscription",
        deliveryId: "mal_1",
        type: "subscription.updated",
        subscription: {
          subscriptionId: "",
          customerId: "cus_x",
          externalCustomerId: team.id,
          productId: "prod_pro",
          status: "active",
          currentPeriodStart: new Date("nope"),
          currentPeriodEnd: new Date("nope"),
          cancelAtPeriodEnd: false,
          modifiedAt: new Date("nope"),
          hasMeteredPrice: true,
          overageCapCents: null,
          plan: null,
          claimsPlan: false,
        },
      }),
      "{}",
      NO_HEADERS,
    );
    expect(r).toMatchObject({
      status: 200,
      applied: false,
      reason: "malformed_payload",
    });
    expect(await billingRow(team.id)).toBeUndefined();
    const [row] = await db()
      .select()
      .from(billingEvents)
      .where(eq(billingEvents.id, "mal_1"));
    expect(row).toMatchObject({
      appliedAt: null,
      skippedReason: "malformed_payload",
    });
  });

  it("rolls the delivery row back when applying it throws", async () => {
    const { handleProviderEvent } = await import("@/services/billing");
    const { billingRow } = await import("@/services/billing/plans");
    const { db } = await import("@/db");
    const { billingEvents } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    // An allowance no `integer` column can hold: the write blows up *after*
    // the delivery row was inserted, which is exactly the crash window the
    // transaction exists to close.
    const boom = withEvent({
      kind: "subscription",
      deliveryId: "boom_1",
      type: "subscription.created",
      subscription: {
        subscriptionId: "sub_k",
        customerId: "cus_k",
        externalCustomerId: team.id,
        productId: "prod_pro",
        status: "active",
        currentPeriodStart: AUG,
        currentPeriodEnd: SEP,
        cancelAtPeriodEnd: false,
        modifiedAt: AUG,
        hasMeteredPrice: true,
        overageCapCents: null,
        plan: { plan: "pro", includedEmails: 2 ** 31, overagePer1kCents: 40 },
        claimsPlan: true,
      },
    });
    await expect(handleProviderEvent(boom, "{}", NO_HEADERS)).rejects.toThrow();
    // Nothing recorded, so the redelivery is not short-circuited as a
    // duplicate for an event that was never applied.
    expect(
      await db()
        .select()
        .from(billingEvents)
        .where(eq(billingEvents.id, "boom_1")),
    ).toHaveLength(0);
    expect(await billingRow(team.id)).toBeUndefined();
    const good = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_k",
      externalCustomerId: team.id,
      productId: "prod_pro",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
      deliveryId: "boom_1",
    });
    expect(
      await handleProviderEvent(provider, good.body, good.headers),
    ).toMatchObject({ applied: true });
  });
});

describe("teamBillingState", () => {
  const NOW = new Date("2026-08-25T12:00:00Z");

  it("renders the entitlement, the deadline and the metering watermark", async () => {
    const { handleProviderEvent, teamBillingState } =
      await import("@/services/billing");
    const { db } = await import("@/db");
    const { billingUsage } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    const e = provider.signSubscriptionEvent("subscription.created", {
      subscriptionId: "sub_state",
      externalCustomerId: team.id,
      productId: "prod_pro",
      status: "active",
      currentPeriodStart: AUG,
      currentPeriodEnd: SEP,
    });
    await handleProviderEvent(provider, e.body, e.headers);
    await db().insert(billingUsage).values({
      teamId: team.id,
      periodStart: AUG,
      periodEnd: SEP,
      reportedUnits: 17,
    });
    expect(await teamBillingState(team.id, NOW)).toMatchObject({
      enabled: true,
      plan: "pro",
      status: "active",
      includedEmails: 50000,
      overagePer1kCents: 40,
      overageEnabled: true,
      periodStart: AUG.toISOString(),
      periodEnd: SEP.toISOString(),
      used: 0,
      reportedUnits: 17,
      managed: true,
      pastDueAt: null,
    });
  });

  it("reads the watermark on the stored period, not the entitlement window", async () => {
    const { teamBillingState } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { billingUsage, teamBilling } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    // A renewal webhook that never landed: the stored period is stale, so the
    // entitlement window rolls forward onto the next anniversary — but the
    // usage row is still keyed on the stored period start (amendment E).
    const storedStart = new Date("2026-06-10T00:00:00Z");
    const storedEnd = new Date("2026-07-10T00:00:00Z");
    await db().insert(teamBilling).values({
      teamId: team.id,
      plan: "pro",
      status: "active",
      includedEmails: 50000,
      overagePer1kCents: 40,
      overageEnabled: true,
      periodStart: storedStart,
      periodEnd: storedEnd,
      providerModifiedAt: storedStart,
    });
    await db().insert(billingUsage).values({
      teamId: team.id,
      periodStart: storedStart,
      periodEnd: storedEnd,
      reportedUnits: 99,
    });
    expect(await teamBillingState(team.id, NOW)).toMatchObject({
      plan: "pro",
      periodStart: "2026-08-09T00:00:00.000Z",
      periodEnd: "2026-09-08T00:00:00.000Z",
      reportedUnits: 99,
    });
  });

  it("reports the free plan and the past-due deadline once the grace has run out", async () => {
    const { teamBillingState } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { teamBilling } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    const pastDueAt = new Date("2026-08-10T00:00:00Z");
    await db().insert(teamBilling).values({
      teamId: team.id,
      plan: "pro",
      status: "past_due",
      includedEmails: 50000,
      overagePer1kCents: 40,
      overageEnabled: true,
      periodStart: AUG,
      periodEnd: SEP,
      providerModifiedAt: AUG,
      pastDueAt,
    });
    expect(await teamBillingState(team.id, NOW)).toMatchObject({
      plan: "free",
      status: "past_due",
      includedEmails: 3000,
      overageEnabled: false,
      managed: true,
      pastDueAt: pastDueAt.toISOString(),
    });
  });
});
