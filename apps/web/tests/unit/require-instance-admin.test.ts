import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `requireInstanceAdmin` never touches the database — it reads the session and
 * the env — so it is exercised here rather than in the integration project.
 * `redirect` is stubbed to throw the way Next's real one does, which is what
 * lets "sends them to /app" be asserted at all.
 */
const REDIRECT = "NEXT_REDIRECT";
const redirect = vi.fn((path: string) => {
  throw new Error(`${REDIRECT}:${path}`);
});
const getSession = vi.fn();

vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));

const session = (email: string, instanceAdmin: boolean) => ({
  user: { id: "u1", email, instanceAdmin },
  session: { activeOrganizationId: null },
});

beforeEach(async () => {
  vi.clearAllMocks();
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
