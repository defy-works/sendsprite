import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `requireInstanceAdmin` reads the session, the env and one column — whether
 * the account is banned — so it is exercised here rather than in the
 * integration project, with that lookup stubbed. `redirect` is stubbed to
 * throw the way Next's real one does, which is what lets "sends them to /app"
 * be asserted at all.
 */
const REDIRECT = "NEXT_REDIRECT";
const redirect = vi.fn((path: string) => {
  throw new Error(`${REDIRECT}:${path}`);
});
const getSession = vi.fn();

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));

/**
 * The one query these functions do make: the ban check in `requireSession`.
 *
 * Stubbed rather than pointed at a database, because everything else here is
 * the session and the environment — and a lookup that returns "not banned" is
 * the shape every other assertion in this file assumes.
 */
const bannedAt = vi.fn<() => Date | null>(() => null);
vi.mock("@/db", () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ at: bannedAt() }] }),
      }),
    }),
  }),
}));

const session = (email: string, instanceAdmin: boolean) => ({
  user: { id: "u1", email, instanceAdmin },
  session: { activeOrganizationId: null },
});

beforeEach(async () => {
  vi.clearAllMocks();
  bannedAt.mockReturnValue(null);
  delete process.env.INSTANCE_ADMIN_EMAILS;
  process.env.APP_URL = "http://localhost:3000";
  process.env.APP_SECRET = "x".repeat(40);
  process.env.DATABASE_URL = "postgres://x/y";
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
});
afterEach(async () => {
  delete process.env.INSTANCE_ADMIN_EMAILS;
  const { resetEnvCache } = await import("@/env.schema");
  resetEnvCache();
});

describe("requireInstanceAdmin", () => {
  it("passes a flagged user", async () => {
    getSession.mockResolvedValue(session("flagged@x.com", true));
    const { requireInstanceAdmin } = await import("@/lib/session");
    const s = await requireInstanceAdmin();
    expect(s.user.email).toBe("flagged@x.com");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("sends a banned account to /banned, flag or no flag", async () => {
    // The ban is checked before the privilege: an operator who has been locked
    // out of the instance does not get to keep the one surface that unbans.
    bannedAt.mockReturnValue(new Date());
    getSession.mockResolvedValue(session("flagged@x.com", true));
    const { requireInstanceAdmin } = await import("@/lib/session");
    await expect(requireInstanceAdmin()).rejects.toThrow(`${REDIRECT}:/banned`);
  });

  it("passes an env-listed email even when unflagged", async () => {
    process.env.INSTANCE_ADMIN_EMAILS = "Ops@X.com, other@x.com";
    const { resetEnvCache } = await import("@/env.schema");
    resetEnvCache();
    getSession.mockResolvedValue(session("ops@x.com", false));
    const { requireInstanceAdmin } = await import("@/lib/session");
    const s = await requireInstanceAdmin();
    expect(s.user.email).toBe("ops@x.com");
  });

  it("redirects an unflagged, unlisted user to /app", async () => {
    getSession.mockResolvedValue(session("owner@x.com", false));
    const { requireInstanceAdmin } = await import("@/lib/session");
    await expect(requireInstanceAdmin()).rejects.toThrow(`${REDIRECT}:/app`);
  });

  it("redirects an unauthenticated visitor to /login", async () => {
    getSession.mockResolvedValue(null);
    const { requireInstanceAdmin } = await import("@/lib/session");
    await expect(requireInstanceAdmin()).rejects.toThrow(`${REDIRECT}:/login`);
  });
});
