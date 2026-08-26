import { beforeEach, describe, expect, it, vi } from "vitest";

// The socket and the certificate are exercised for real in
// tests/integration/smtp-boot.test.ts; here the point is what `startRelay`
// does with a failure, so both are stubbed and every branch is reachable.
const startSmtp = vi.fn<(opts: unknown) => Promise<void>>();
vi.mock("@/smtp/server", () => ({ startSmtp }));
const loadOrGenerateCert = vi.fn(async () => ({ key: "KEY", cert: "CERT" }));
vi.mock("@/smtp/tls", () => ({ loadOrGenerateCert }));

const { startRelay } = await import("@/smtp/boot");
const { getSmtpState, setSmtpState } = await import("@/smtp/state");

const errno = (code: string) =>
  Object.assign(new Error(`listen ${code} 0.0.0.0`), { code });

let errors: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  loadOrGenerateCert.mockResolvedValue({ key: "KEY", cert: "CERT" });
  setSmtpState({ status: "disabled" });
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  });
});
const log = () => errors.join("\n");

describe("startRelay", () => {
  it("passes the configured relay options through", async () => {
    startSmtp.mockResolvedValue();
    await expect(
      startRelay({
        port: 2587,
        maxSize: 4096,
        allowInsecureAuth: true,
        tlsCert: "/c.pem",
        tlsKey: "/k.pem",
      }),
    ).resolves.toBe(true);
    expect(loadOrGenerateCert).toHaveBeenCalledWith({
      cert: "/c.pem",
      key: "/k.pem",
    });
    expect(startSmtp).toHaveBeenCalledWith({
      port: 2587,
      maxSize: 4096,
      allowInsecureAuth: true,
      tls: { key: "KEY", cert: "CERT" },
    });
    expect(errors).toEqual([]);
  });

  // The regression: the container runs as the non-root `bun` user, so
  // binding 587 raises EACCES. It used to reject out of the instrumentation
  // hook, which took the dashboard and the REST API down with it.
  it("survives a privileged port and explains it", async () => {
    startSmtp.mockRejectedValue(errno("EACCES"));
    await expect(startRelay({ port: 587 })).resolves.toBe(false);
    expect(getSmtpState()).toEqual({
      status: "failed",
      port: 587,
      code: "EACCES",
    });
    expect(log()).toContain("587");
    expect(log()).toContain("privileged");
    expect(log()).toContain("CAP_NET_BIND_SERVICE");
    // Names the way out: an unprivileged port inside, 587 published outside.
    expect(log()).toContain("2587");
    expect(log()).toMatch(/dashboard, REST API and worker are unaffected/);
  });

  it("survives a busy port", async () => {
    startSmtp.mockRejectedValue(errno("EADDRINUSE"));
    await expect(startRelay({ port: 2587 })).resolves.toBe(false);
    expect(getSmtpState()).toEqual({
      status: "failed",
      port: 2587,
      code: "EADDRINUSE",
    });
    expect(log()).toContain("2587 is already in use");
  });

  it("does not blame privileges for an EACCES above 1023", async () => {
    startSmtp.mockRejectedValue(errno("EACCES"));
    await expect(startRelay({ port: 2587 })).resolves.toBe(false);
    expect(log()).not.toContain("privileged");
    expect(log()).toContain("not allowed to bind port 2587");
  });

  it("survives unreadable TLS material and points at the variables", async () => {
    loadOrGenerateCert.mockRejectedValue(errno("ENOENT"));
    await expect(
      startRelay({ port: 2587, tlsCert: "/nope.pem", tlsKey: "/nope.key" }),
    ).resolves.toBe(false);
    expect(startSmtp).not.toHaveBeenCalled();
    expect(getSmtpState()).toEqual({
      status: "failed",
      port: 2587,
      code: "ENOENT",
    });
    expect(log()).toContain("SMTP_TLS_CERT");
  });

  it("survives an error with no errno at all", async () => {
    startSmtp.mockRejectedValue(new Error("boom"));
    await expect(startRelay({ port: 2587 })).resolves.toBe(false);
    expect(getSmtpState().code).toBe("ERROR");
    expect(log()).toContain("boom");
  });
});
