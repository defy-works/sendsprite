/**
 * `/admin/organizations` — the instance operator's list of every team.
 *
 * It shipped broken and nothing here noticed, because nothing here ran it:
 * the page 500'd on its own query. The three per-team counts are correlated
 * subqueries, and the send count compared `emails.created_at` against a `Date`
 * interpolated into a hand-written `sql` template. A raw template runs no
 * column encoder, so postgres.js was handed the object itself and refused it
 * (`Received an instance of Date`). Executing the query at all is most of what
 * this file is for; the counts are checked because a subquery that returns the
 * wrong number is the other way this page misleads its only reader.
 */
import { randomBytes } from "node:crypto";
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

const DAY = 24 * 60 * 60 * 1000;

async function addDomain(teamId: string) {
  const { db } = await import("@/db");
  const { domains } = await import("@/db/schema");
  const name = `${randomBytes(4).toString("hex")}.example.com`;
  await db()
    .insert(domains)
    .values({
      id: `dom_${randomBytes(6).toString("hex")}`,
      teamId,
      name,
      region: "eu-west-1",
      dnsMode: "manual",
      status: "verified",
      mailFromDomain: `bounce.${name}`,
    });
}

async function addMember(teamId: string) {
  const { db } = await import("@/db");
  const { member, user } = await import("@/db/schema");
  const suffix = randomBytes(6).toString("hex");
  await db()
    .insert(user)
    .values({
      id: `u_${suffix}`,
      name: `User ${suffix}`,
      email: `${suffix}@example.com`,
    });
  await db()
    .insert(member)
    .values({
      id: `mem_${suffix}`,
      organizationId: teamId,
      userId: `u_${suffix}`,
      role: "member",
      createdAt: new Date(),
    });
}

async function addEmail(
  teamId: string,
  status: "sent" | "failed" | "cancelled",
  createdAt: Date,
) {
  const { db } = await import("@/db");
  const { emails } = await import("@/db/schema");
  const { newId } = await import("@sendsprite/shared");
  await db()
    .insert(emails)
    .values({
      id: newId("em"),
      teamId,
      from: "a@b.io",
      fromEmail: "a@b.io",
      to: ["c@d.io"],
      subject: "s",
      status,
      createdAt,
    });
}

describe("listOrganizations", () => {
  it("counts members, domains and the last 30 days of billable sends", async () => {
    const { listOrganizations } = await import("@/services/admin");
    const { team } = await seedTeamWithKey();
    const now = Date.now();

    await addMember(team.id);
    await addMember(team.id);
    await addDomain(team.id);

    await addEmail(team.id, "sent", new Date(now - DAY));
    await addEmail(team.id, "sent", new Date(now - 29 * DAY));
    // Outside the window.
    await addEmail(team.id, "sent", new Date(now - 31 * DAY));
    // Inside it, but never consumed a send.
    await addEmail(team.id, "cancelled", new Date(now - DAY));

    const row = (await listOrganizations()).find((o) => o.id === team.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      name: team.name,
      slug: team.slug,
      members: 2,
      domains: 1,
      sent30d: 2,
    });
  });

  it("a team with nothing in it counts zero rather than going missing", async () => {
    const { listOrganizations } = await import("@/services/admin");
    const { team } = await seedTeamWithKey();
    expect(
      (await listOrganizations()).find((o) => o.id === team.id),
    ).toMatchObject({ members: 0, domains: 0, sent30d: 0 });
  });

  it("searches name and slug, case-insensitively, and matches nothing else", async () => {
    const { listOrganizations } = await import("@/services/admin");
    const { team } = await seedTeamWithKey();
    const ids = async (q: string) =>
      (await listOrganizations(q)).map((o) => o.id);

    expect(await ids(team.name.toUpperCase())).toContain(team.id);
    expect(await ids(team.slug)).toEqual([team.id]);
    expect(await ids(`no-such-team-${randomBytes(4).toString("hex")}`)).toEqual(
      [],
    );
  });
});
