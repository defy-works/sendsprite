import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRole } from "@sendsprite/shared";

/**
 * Like `require-instance-admin.test.ts`: no database is involved once
 * `resolveTeam` is stubbed, so this belongs in the unit project.
 */
const REDIRECT = "NEXT_REDIRECT";
const redirect = vi.fn((path: string) => {
  throw new Error(`${REDIRECT}:${path}`);
});
const getSession = vi.fn();
const resolveTeam = vi.fn();

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
vi.mock("@/lib/team", () => ({ resolveTeam }));

const asRole = (role: TeamRole) => {
  getSession.mockResolvedValue({
    user: { id: "u1", email: "a@x.com" },
    session: { activeOrganizationId: "org1" },
  });
  resolveTeam.mockResolvedValue({
    userId: "u1",
    team: { id: "org1", name: "Acme", slug: "acme" },
    role,
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = "http://localhost:3000";
  process.env.APP_SECRET = "x".repeat(40);
  process.env.DATABASE_URL = "postgres://x/y";
});

describe("requireTeamAdmin", () => {
  it("passes an owner", async () => {
    asRole("owner");
    const { requireTeamAdmin } = await import("@/lib/session");
    expect((await requireTeamAdmin()).role).toBe("owner");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("passes an admin", async () => {
    asRole("admin");
    const { requireTeamAdmin } = await import("@/lib/session");
    expect((await requireTeamAdmin()).role).toBe("admin");
  });

  it("redirects a plain member to /app", async () => {
    asRole("member");
    const { requireTeamAdmin } = await import("@/lib/session");
    await expect(requireTeamAdmin()).rejects.toThrow(`${REDIRECT}:/app`);
  });

  it("sends a user with no team to /teams/new", async () => {
    getSession.mockResolvedValue({
      user: { id: "u1", email: "a@x.com" },
      session: { activeOrganizationId: null },
    });
    resolveTeam.mockResolvedValue(null);
    const { requireTeamAdmin } = await import("@/lib/session");
    await expect(requireTeamAdmin()).rejects.toThrow(`${REDIRECT}:/teams/new`);
  });
});
