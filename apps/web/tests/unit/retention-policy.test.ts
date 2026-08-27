import { describe, expect, it } from "vitest";
import { effectiveRetentionDays } from "@/services/retention-policy";

describe("effectiveRetentionDays", () => {
  it("uses the instance maximum when the team has not chosen", () => {
    expect(effectiveRetentionDays(null, 90)).toBe(90);
  });
  it("honours a shorter team window", () => {
    expect(effectiveRetentionDays(30, 90)).toBe(30);
  });
  it("clamps a longer team window to the ceiling", () => {
    expect(effectiveRetentionDays(365, 90)).toBe(90);
  });
  it("clamps an equal window to itself", () => {
    expect(effectiveRetentionDays(90, 90)).toBe(90);
  });
  it("never returns less than 1", () => {
    expect(effectiveRetentionDays(0, 90)).toBe(1);
    expect(effectiveRetentionDays(-5, 90)).toBe(1);
  });
});
