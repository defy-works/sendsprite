import { describe, expect, it } from "vitest";
import { describeOAuthError } from "@/lib/oauth-error";

describe("describeOAuthError", () => {
  it("is null without a code", () => {
    expect(describeOAuthError(undefined)).toBeNull();
  });
  it("names known codes", () => {
    expect(describeOAuthError("access_denied")).toMatch(/cancelled/);
    expect(describeOAuthError("signup_disabled")).toMatch(/closed/);
  });
  it("falls back to a readable generic sentence", () => {
    expect(describeOAuthError("state_not_found")).toBe(
      "Sign-in failed (state not found). Please try again.",
    );
  });
});
