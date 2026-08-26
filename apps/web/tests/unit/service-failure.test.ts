import { describe, expect, it } from "vitest";
import { serviceFailure } from "@/lib/api-response";

describe("serviceFailure", () => {
  it("maps a typed code to its HTTP status", async () => {
    const r = serviceFailure({ ok: false, error: "gone", code: "not_found" });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({
      error: { code: "not_found", message: "gone" },
    });
  });
  it("defaults to validation_error when the service gave no code", async () => {
    const r = serviceFailure({ ok: false, error: "bad" });
    expect(r.status).toBe(400);
  });
  it("treats an unknown upstream code (e.g. an AWS error name) as internal", async () => {
    const r = serviceFailure({ ok: false, error: "x", code: "Throttling" });
    expect(r.status).toBe(500);
    expect((await r.json()).error.code).toBe("internal_error");
  });
  it("forwards details and headers", async () => {
    const r = serviceFailure(
      {
        ok: false,
        error: "x",
        code: "domain_not_verified",
        details: { index: 1 },
      },
      { "x-ratelimit-limit": "10" },
    );
    expect(r.status).toBe(422);
    expect(r.headers.get("x-ratelimit-limit")).toBe("10");
    expect((await r.json()).error.details).toEqual({ index: 1 });
  });
});
