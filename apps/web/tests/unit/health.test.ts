import { describe, expect, it } from "vitest";
import { summarize, type Checks } from "@/lib/health";

const base: Checks = {
  db: "ok",
  worker: "running",
  queueLag: 0,
  workerLastSeenSeconds: 30,
  smtp: { status: "disabled" },
};
const s = (over: Partial<Checks>, mode = "inline") =>
  summarize({ ...base, ...over }, mode);

describe("health summarize", () => {
  it("is error when db is down, regardless of the worker", () => {
    expect(s({ db: "error" }).status).toBe("error");
  });
  it("degrades when queue lag exceeds 60s", () => {
    expect(s({ queueLag: 61 }).status).toBe("degraded");
    expect(s({ queueLag: 60 }).status).toBe("ok");
  });
  it("reports running from a fresh heartbeat when this process has no worker", () => {
    const h = s({ worker: "disabled", workerLastSeenSeconds: 5 * 60 });
    expect(h.worker).toBe("running");
    expect(h.status).toBe("ok");
    // 10 min and older is no longer "running", but not yet degraded.
    const aging = s({ worker: "disabled", workerLastSeenSeconds: 10 * 60 });
    expect(aging.worker).toBe("disabled");
    expect(aging.status).toBe("ok");
  });
  it("degrades when a worker is expected but none has checked in for 15 min", () => {
    expect(
      s({ worker: "disabled", workerLastSeenSeconds: 15 * 60 }).status,
    ).toBe("degraded");
    expect(s({ worker: "stopped", workerLastSeenSeconds: null }).status).toBe(
      "degraded",
    );
    expect(
      s({ worker: "disabled", workerLastSeenSeconds: null }, "separate").status,
    ).toBe("degraded");
  });
  it("degrades when the SMTP relay could not start, and says which port", () => {
    const h = s({ smtp: { status: "failed", port: 587, code: "EACCES" } });
    expect(h.status).toBe("degraded");
    expect(h.smtp).toEqual({ status: "failed", port: 587, code: "EACCES" });
    // A relay that is simply off, or listening, is not a problem.
    expect(s({ smtp: { status: "listening", port: 2587 } }).status).toBe("ok");
  });
  it("does not degrade without a worker when WORKER_MODE=none", () => {
    const h = s({ worker: "disabled", workerLastSeenSeconds: null }, "none");
    expect(h.worker).toBe("disabled");
    expect(h.status).toBe("ok");
  });
  it("an in-process worker is running even with a stale heartbeat table", () => {
    const h = s({ worker: "running", workerLastSeenSeconds: null });
    expect(h.worker).toBe("running");
    expect(h.status).toBe("ok");
  });
});
