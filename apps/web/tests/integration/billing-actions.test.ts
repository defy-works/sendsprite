import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";
import type { FakeProvider } from "@/services/billing/fake";
import type { BillingProvider } from "@/services/billing/provider";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_URL = "https://mail.example.com";
  process.env.BILLING_ENABLED = "1";
  process.env.BILLING_PROVIDER = "fake";
  (await import("@/env.schema")).resetEnvCache();
});
afterAll(async () => {
  await pg.stop();
  delete process.env.BILLING_ENABLED;
  delete process.env.BILLING_PROVIDER;
});

const OWNER = (teamId: string) =>
  ({ teamId, userId: "u_1", role: "owner" }) as const;

/** A provider whose every call reports a misconfigured integration. */
async function unavailableProvider(): Promise<BillingProvider> {
  const { createFakeProvider } = await import("@/services/billing/fake");
  const { BillingUnavailableError } =
    await import("@/services/billing/provider");
  const boom = () => {
    throw new BillingUnavailableError("POLAR_ACCESS_TOKEN is empty");
  };
  return {
    ...createFakeProvider(),
    listPlanProducts: boom,
    createPortalSession: boom,
  };
}

const subscribe = async (teamId: string) => {
  const { db } = await import("@/db");
  const { teamBilling } = await import("@/db/schema");
  await db()
    .insert(teamBilling)
    .values({
      teamId,
      provider: "fake",
      providerCustomerId: "cus_1",
      subscriptionId: "sub_1",
      plan: "pro",
      status: "active",
      includedEmails: 50000,
      overagePer1kCents: 40,
      overageEnabled: true,
      periodStart: new Date("2026-08-01T00:00:00Z"),
      periodEnd: new Date("2026-09-01T00:00:00Z"),
      providerModifiedAt: new Date("2026-08-01T00:00:00Z"),
    });
};

describe("startCheckout", () => {
  it("returns a checkout URL for a known plan", async () => {
    const { startCheckout } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    const r = await startCheckout(
      { ...OWNER(team.id), email: "a@b.io" },
      "pro",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.url).toContain("prod_pro");
    expect(r.data.url).toContain(encodeURIComponent(team.id));
  });

  it("writes a billing.checkout audit row", async () => {
    const { startCheckout } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await startCheckout(OWNER(team.id), "scale");
    const rows = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.teamId, team.id),
          eq(auditLog.action, "billing.checkout"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe("scale");
    expect(rows[0]!.actorUserId).toBe("u_1");
  });

  it("refuses an unknown plan", async () => {
    const { startCheckout } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    expect(await startCheckout(OWNER(team.id), "enterprise")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("refuses a raw provider product id: only a plan the catalog knows", async () => {
    // The caller names a *plan*; the product id is resolved from the
    // provider's own catalog. Handing one straight through would let anyone
    // subscribe their team to an arbitrary product.
    const { startCheckout } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    expect(await startCheckout(OWNER(team.id), "prod_pro")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("refuses a member: seeing the plan is not buying one", async () => {
    const { startCheckout } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    expect(
      await startCheckout(
        { teamId: team.id, userId: "u_1", role: "member" },
        "pro",
      ),
    ).toMatchObject({ ok: false, code: "forbidden" });
    // A refusal is not an event: nothing is written for it.
    expect(
      await db()
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.teamId, team.id),
            eq(auditLog.action, "billing.checkout"),
          ),
        ),
    ).toHaveLength(0);
  });

  it("admins may buy", async () => {
    const { startCheckout } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    expect(
      await startCheckout(
        { teamId: team.id, userId: "u_1", role: "admin" },
        "pro",
      ),
    ).toMatchObject({ ok: true });
  });

  it("reports a misconfigured provider as such, not as a generic failure", async () => {
    const { startCheckout } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    const r = await startCheckout(
      OWNER(team.id),
      "pro",
      await unavailableProvider(),
    );
    expect(r).toMatchObject({ ok: false, code: "not_configured" });
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/not configured/i);
    expect(r.error).not.toMatch(/POLAR_ACCESS_TOKEN|Error:/);
  });

  it("hands an owner the underlying reason, out of band from the message", async () => {
    // A misconfigured provider on a self-hosted instance is usually the fault
    // of the person clicking, and "contact support" wastes the one diagnosis
    // they could have made. The detail rides in `details`, never in `error`:
    // the customer-facing string stays stable and a renderer cannot leak the
    // diagnostic by reaching for the wrong field.
    const { startCheckout } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    const r = await startCheckout(
      OWNER(team.id),
      "pro",
      await unavailableProvider(),
    );
    if (r.ok) throw new Error("unreachable");
    expect(r.details).toEqual({
      providerDetail: "BillingUnavailableError: POLAR_ACCESS_TOKEN is empty",
    });
    expect(r.error).not.toMatch(/POLAR_ACCESS_TOKEN/);
  });

  it("withholds it from an admin, who cannot set the variable it names", async () => {
    const { startCheckout } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    const r = await startCheckout(
      { teamId: team.id, userId: "u_1", role: "admin" },
      "pro",
      await unavailableProvider(),
    );
    expect(r).toMatchObject({ ok: false, code: "not_configured" });
    if (r.ok) throw new Error("unreachable");
    expect(r.details).toBeUndefined();
  });

  it("does not attach it to an ordinary failure", async () => {
    // Only `BillingUnavailableError` is an operator problem; a transient
    // provider error is not, and must not turn into a configuration hint.
    const { startCheckout } = await import("@/services/billing");
    const { createFakeProvider } = await import("@/services/billing/fake");
    const { team } = await seedTeamWithKey();
    const provider = createFakeProvider();
    provider.failNext("connect ECONNREFUSED");
    const r = await startCheckout(OWNER(team.id), "pro", provider);
    expect(r).toMatchObject({ ok: false, code: "internal_error" });
    if (r.ok) throw new Error("unreachable");
    expect(r.details).toBeUndefined();
  });
});

describe("planCatalog", () => {
  it("lists the provider's plan products", async () => {
    const { planCatalog } = await import("@/services/billing");
    const c = await planCatalog();
    expect(c.products.map((p) => p.plan)).toEqual(["free", "pro", "scale"]);
    expect(c.error).toBeNull();
  });

  it("degrades to an empty catalog and reports why", async () => {
    // The page must still render the team's plan and usage from our own
    // tables when the provider is unreachable; only the upgrade grid is lost.
    const { planCatalog, getBillingProvider } =
      await import("@/services/billing");
    // `BILLING_PROVIDER=fake`, so the memoised provider is the fake and one
    // `failNext` is enough to stage an outage for exactly the next call.
    const provider = (await getBillingProvider()) as FakeProvider;
    provider.failNext("catalog is down");
    const c = await planCatalog();
    expect(c.products).toEqual([]);
    expect(c.error).toBe("Error: catalog is down");
  });

  it("is empty and silent with billing off", async () => {
    const { resetEnvCache } = await import("@/env.schema");
    const { planCatalog } = await import("@/services/billing");
    delete process.env.BILLING_ENABLED;
    resetEnvCache();
    expect(await planCatalog()).toEqual({ products: [], error: null });
    process.env.BILLING_ENABLED = "1";
    resetEnvCache();
  });
});

describe("openPortal", () => {
  it("refuses the portal for a team that never subscribed", async () => {
    const { openPortal } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    expect(await openPortal(OWNER(team.id))).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("returns a portal URL once a subscription exists", async () => {
    const { openPortal } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    await subscribe(team.id);
    const r = await openPortal(OWNER(team.id));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.data.url).toContain(encodeURIComponent(team.id));
  });

  it("writes a billing.portal audit row", async () => {
    const { openPortal } = await import("@/services/billing");
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await subscribe(team.id);
    await openPortal(OWNER(team.id));
    const rows = await db()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.teamId, team.id),
          eq(auditLog.action, "billing.portal"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe("sub_1");
  });

  it("refuses a member even when the team is subscribed", async () => {
    const { openPortal } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    await subscribe(team.id);
    expect(
      await openPortal({ teamId: team.id, userId: "u_1", role: "member" }),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("reports a misconfigured provider as such, not as a generic failure", async () => {
    const { openPortal } = await import("@/services/billing");
    const { team } = await seedTeamWithKey();
    await subscribe(team.id);
    const r = await openPortal(OWNER(team.id), await unavailableProvider());
    expect(r).toMatchObject({ ok: false, code: "not_configured" });
    if (r.ok) throw new Error("unreachable");
    expect(r.error).toMatch(/not configured/i);
  });
});

describe("billing disabled", () => {
  it("both refuse when billing is off", async () => {
    const { resetEnvCache } = await import("@/env.schema");
    const { openPortal, startCheckout, resetBillingProvider } =
      await import("@/services/billing");
    delete process.env.BILLING_ENABLED;
    resetEnvCache();
    resetBillingProvider();
    const { team } = await seedTeamWithKey();
    await subscribe(team.id);
    expect(await startCheckout(OWNER(team.id), "pro")).toMatchObject({
      ok: false,
      code: "not_configured",
    });
    expect(await openPortal(OWNER(team.id))).toMatchObject({
      ok: false,
      code: "not_configured",
    });
    process.env.BILLING_ENABLED = "1";
    resetEnvCache();
    resetBillingProvider();
  });
});
