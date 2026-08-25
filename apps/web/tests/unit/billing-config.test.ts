import { afterEach, describe, expect, it } from "vitest";
import { parseEnv } from "@/env.schema";
import { billingConfig } from "@/services/billing/config";

const BASE = {
  APP_URL: "https://mail.example.com",
  APP_SECRET: "x".repeat(40),
  DATABASE_URL: "postgres://x/y",
};

afterEach(() => {
  for (const k of [
    "BILLING_ENABLED",
    "BILLING_PROVIDER",
    "POLAR_ACCESS_TOKEN",
    "POLAR_WEBHOOK_SECRET",
    "POLAR_METER_ID",
  ])
    delete process.env[k];
});

describe("billingConfig", () => {
  it("reports disabled when the flag is off", () => {
    Object.assign(process.env, BASE);
    expect(billingConfig(parseEnv({ ...BASE })).enabled).toBe(false);
  });

  it("carries the URLs the checkout and portal need", () => {
    const cfg = billingConfig(
      parseEnv({
        ...BASE,
        BILLING_ENABLED: "1",
        POLAR_ACCESS_TOKEN: "t",
        POLAR_WEBHOOK_SECRET: "s",
      }),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.successUrl).toBe(
      "https://mail.example.com/app/settings/billing?checkout={CHECKOUT_ID}",
    );
    expect(cfg.returnUrl).toBe("https://mail.example.com/app/settings/billing");
    expect(cfg.eventName).toBe("email.sent");
    expect(cfg.meterId).toBeNull();
  });
});
