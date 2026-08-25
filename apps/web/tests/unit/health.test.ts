import { describe, expect, it } from "vitest";
import { summarize, type Checks } from "@/lib/health";

const base: Checks = {
  db: "ok",
  worker: "running",
  queueLag: 0,
  workerLastSeenSeconds: 30,
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
