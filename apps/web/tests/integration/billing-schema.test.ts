import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

describe("billing schema", () => {
  it("team_billing is 1:1 with the team and cascades on delete", async () => {
    const { db } = await import("@/db");
    const { organization, teamBilling } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const { team } = await seedTeamWithKey();
    await db()
      .insert(teamBilling)
      .values({
        teamId: team.id,
        plan: "pro",
        status: "active",
        includedEmails: 50000,
        overagePer1kCents: 40,
        overageEnabled: true,
        periodStart: new Date("2026-08-01T00:00:00Z"),
        periodEnd: new Date("2026-09-01T00:00:00Z"),
        providerModifiedAt: new Date("2026-08-01T00:00:00Z"),
      });
    expect(
      await db()
        .select()
        .from(teamBilling)
        .where(eq(teamBilling.teamId, team.id)),
    ).toHaveLength(1);
    await db().delete(organization).where(eq(organization.id, team.id));
    expect(
      await db()
        .select()
        .from(teamBilling)
        .where(eq(teamBilling.teamId, team.id)),
    ).toHaveLength(0);
  });

  it("billing_usage is keyed on (team, periodStart)", async () => {
    const { db } = await import("@/db");
    const { billingUsage } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    const periodStart = new Date("2026-08-01T00:00:00Z");
    const row = {
      teamId: team.id,
      periodStart,
      periodEnd: new Date("2026-09-01T00:00:00Z"),
      reportedThrough: null,
      reportedUnits: 0,
    };
    await db().insert(billingUsage).values(row);
    await expect(db().insert(billingUsage).values(row)).rejects.toThrow();
    // The same team in a different period is a different row.
    await db()
      .insert(billingUsage)
      .values({ ...row, periodStart: new Date("2026-09-01T00:00:00Z") });
  });

  // Migration 0011 exists because a µs/ms mismatch silently skipped rows.
  // These four columns are compared to each other or ordered against a value
  // that has been through a JS `Date`, so lock the precision down rather than
  // trusting the next `db:generate` to preserve it.
  it("stores millisecond precision on the compared timestamps", async () => {
    const { sql } = await import("drizzle-orm");
    const rows = await pg.db.execute(
      sql`select table_name, column_name, datetime_precision
          from information_schema.columns
          where table_schema = 'public'
            and (table_name, column_name) in (
              ('team_billing', 'period_start'),
              ('team_billing', 'provider_modified_at'),
              ('team_billing', 'last_order_paid_at'),
              ('billing_usage', 'period_start'),
              ('billing_events', 'created_at')
            )
          order by table_name, column_name`,
    );
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.datetime_precision).toBe(3);
  });

  it("billing_events rejects a duplicate delivery id (the idempotency key)", async () => {
    const { db } = await import("@/db");
    const { billingEvents } = await import("@/db/schema");
    const { team } = await seedTeamWithKey();
    const row = {
      id: "evt_delivery_1",
      teamId: team.id,
      type: "subscription.updated",
      objectId: "sub_1",
    };
    await db().insert(billingEvents).values(row);
    const inserted = await db()
      .insert(billingEvents)
      .values({ ...row, type: "subscription.created" })
      .onConflictDoNothing({ target: billingEvents.id })
      .returning();
    expect(inserted).toHaveLength(0);
  });
});
