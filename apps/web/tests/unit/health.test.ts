import { describe, expect, it } from "vitest";
import { summarize } from "@/lib/health";

describe("health summarize", () => {
  it("is ok only when db is ok; worker state is informational", () => {
    expect(summarize({ db: "ok", worker: "running", queueLag: 0 }).status).toBe(
      "ok",
    );
    expect(
      summarize({ db: "ok", worker: "disabled", queueLag: 0 }).status,
    ).toBe("ok");
    expect(
      summarize({ db: "error", worker: "running", queueLag: 0 }).status,
    ).toBe("error");
  });
  it("degrades when queue lag exceeds 60s", () => {
    expect(
      summarize({ db: "ok", worker: "running", queueLag: 61 }).status,
    ).toBe("degraded");
  });
});
