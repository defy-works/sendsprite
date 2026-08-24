import { describe, expect, it } from "vitest";
import { resolveSignupMode, canSignUp } from "@/lib/signup-policy";

describe("resolveSignupMode", () => {
  it("auto → open when no users exist, invite afterwards", () => {
    expect(resolveSignupMode("auto", null, 0)).toBe("open");
    expect(resolveSignupMode("auto", null, 1)).toBe("invite");
  });
  it("db override beats env auto but not an explicit env value", () => {
    expect(resolveSignupMode("auto", "closed", 5)).toBe("closed");
    expect(resolveSignupMode("open", "closed", 5)).toBe("open");
  });
});

describe("canSignUp", () => {
  it("open allows anyone", () => expect(canSignUp("open", false)).toBe(true));
  it("invite requires a pending invitation", () => {
    expect(canSignUp("invite", false)).toBe(false);
    expect(canSignUp("invite", true)).toBe(true);
  });
  it("closed rejects even invited users", () =>
    expect(canSignUp("closed", true)).toBe(false));
});
