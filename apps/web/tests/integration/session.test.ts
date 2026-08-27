import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { member, organization, user } from "@/db/schema";
import { listTeamAdminEmails, resolveTeam } from "@/lib/team";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  await pg.db.insert(user).values([
    { id: "u1", name: "One", email: "one@example.com" },
    { id: "u2", name: "Two", email: "two@example.com" },
    { id: "u3", name: "Three", email: "three@example.com" },
    { id: "u4", name: "Four", email: "four@example.com" },
  ]);
  const t0 = new Date("2026-01-01T00:00:00Z");
  const t1 = new Date("2026-01-02T00:00:00Z");
  await pg.db.insert(organization).values([
    { id: "org1", name: "Org 1", slug: "org-1", createdAt: t0 },
    { id: "org2", name: "Org 2", slug: "org-2", createdAt: t1 },
  ]);
  await pg.db.insert(member).values([
    {
      id: "m1",
      organizationId: "org1",
      userId: "u1",
      role: "owner",
      createdAt: t0,
    },
    {
      id: "m2",
      organizationId: "org2",
      userId: "u1",
      role: "member",
      createdAt: t1,
    },
    // u3 owns org2; u4 is a plain member of org2 only.
    {
      id: "m3",
      organizationId: "org2",
      userId: "u3",
      role: "owner",
      createdAt: t1,
    },
    {
      id: "m4",
      organizationId: "org2",
      userId: "u4",
      role: "member",
      createdAt: t1,
    },
  ]);
});
afterAll(async () => {
  await pg.stop();
});

describe("resolveTeam", () => {
  it("prefers the active organization", async () => {
    const ctx = await resolveTeam("u1", "org2");
    expect(ctx?.team.id).toBe("org2");
    expect(ctx?.role).toBe("member");
  });
  it("falls back to the oldest membership when the active id is stale", async () => {
    const ctx = await resolveTeam("u1", "org_missing");
    expect(ctx?.team).toEqual({ id: "org1", name: "Org 1", slug: "org-1" });
    expect(ctx?.role).toBe("owner");
  });
  it("uses the oldest membership when no active id is set", async () => {
    expect((await resolveTeam("u1", null))?.team.id).toBe("org1");
  });
  it("returns null for a user with no memberships", async () => {
    expect(await resolveTeam("u2", null)).toBeNull();
  });
});

describe("listTeamAdminEmails", () => {
  it("returns the owners and admins of the given team", async () => {
    expect(await listTeamAdminEmails("org2")).toEqual(["three@example.com"]);
  });
  it("covers a team whose only elevated member is its owner", async () => {
    expect(await listTeamAdminEmails("org1")).toEqual(["one@example.com"]);
  });
  it("returns nothing for a team that does not exist", async () => {
    expect(await listTeamAdminEmails("org_missing")).toEqual([]);
  });
});
