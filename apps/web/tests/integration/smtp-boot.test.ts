import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { randomInt } from "node:crypto";

// No database: `startRelay` only touches the certificate and the socket,
// and a relay that never accepts a connection never reaches the DB. The
// stubbed cousin of this file is tests/unit/smtp-boot.test.ts.
const { startRelay } = await import("@/smtp/boot");
const { getSmtpState } = await import("@/smtp/state");
const { stopSmtp } = await import("@/smtp/server");

const freePort = () => 21000 + randomInt(1000);

// 0.0.0.0, the address the relay itself binds: on Windows a listener on
// 127.0.0.1 alone does not collide with the wildcard one.
const occupy = (port: number) =>
  new Promise<net.Server>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(port, "0.0.0.0", () => resolve(s));
  });

afterEach(async () => {
  await stopSmtp();
});

describe("relay boot", () => {
  it("listens, and reports itself to /api/health", async () => {
    const port = freePort();
    await expect(startRelay({ port })).resolves.toBe(true);
    expect(getSmtpState()).toEqual({ status: "listening", port });
    await stopSmtp();
    expect(getSmtpState()).toEqual({ status: "disabled" });
  });

  // A bind failure must resolve, not reject: rejecting out of the
  // instrumentation hook is what made the container 500 on every request.
  it("returns instead of throwing when the port cannot be bound", async () => {
    const port = freePort();
    const squatter = await occupy(port);
    try {
      await expect(startRelay({ port })).resolves.toBe(false);
      expect(getSmtpState()).toEqual({
        status: "failed",
        port,
        code: "EADDRINUSE",
      });
      // And the relay can still be started afterwards on a free port.
      const other = freePort() + 1000;
      await expect(startRelay({ port: other })).resolves.toBe(true);
      expect(getSmtpState().status).toBe("listening");
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });
});
