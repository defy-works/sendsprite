import { describe, expect, it } from "vitest";
import { parseEnv } from "@/env.schema";

const BASE = {
  APP_URL: "https://mail.example.com",
  APP_SECRET: "a".repeat(32),
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
};

describe("parseEnv", () => {
  it("applies defaults", () => {
    const env = parseEnv(BASE);
    expect(env.WORKER_MODE).toBe("inline");
    expect(env.SMTP_ENABLED).toBe(true);
    expect(env.LANDING_ENABLED).toBe(true);
    expect(env.SIGNUP_MODE).toBe("auto");
    expect(env.EMAIL_PASSWORD_ENABLED).toBe(false);
  });
  it("treats an empty string as unset (compose `${VAR:-}` passthrough)", () => {
    const env = parseEnv({
      ...BASE,
      CLOUDFLARE_OAUTH_CLIENT_ID: "",
      POLAR_ACCESS_TOKEN: "",
      CFN_TEMPLATE_URL: "",
      SMTP_ENABLED: "",
      INSTANCE_ADMIN_EMAILS: "",
    });
    expect(env.CLOUDFLARE_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.POLAR_ACCESS_TOKEN).toBeUndefined();
    expect(env.CFN_TEMPLATE_URL).toMatch(/^https:\/\//);
    expect(env.SMTP_ENABLED).toBe(true);
    expect(env.INSTANCE_ADMIN_EMAILS).toBeUndefined();
  });
  it("derives auth provider flags from presence of both id and secret", () => {
    const env = parseEnv({
      ...BASE,
      GOOGLE_CLIENT_ID: "x",
      GOOGLE_CLIENT_SECRET: "y",
      GITHUB_CLIENT_ID: "only-id",
    });
    expect(env.providers.google).toBe(true);
    expect(env.providers.github).toBe(false);
  });
  it("rejects short APP_SECRET", () => {
    expect(() => parseEnv({ ...BASE, APP_SECRET: "short" })).toThrow(
      /APP_SECRET/,
    );
  });
  it("rejects the placeholder APP_SECRET", () => {
    expect(() =>
      parseEnv({ ...BASE, APP_SECRET: "change-me-".padEnd(40, "x") }),
    ).toThrow(/placeholder/);
  });
  it("rejects APP_URL without protocol", () => {
    expect(() => parseEnv({ ...BASE, APP_URL: "mail.example.com" })).toThrow(
      /APP_URL/,
    );
  });
  it("parses booleans from strings", () => {
    const env = parseEnv({
      ...BASE,
      SMTP_ENABLED: "false",
      LANDING_ENABLED: "0",
      EMAIL_PASSWORD_ENABLED: "true",
    });
    expect(env.SMTP_ENABLED).toBe(false);
    expect(env.LANDING_ENABLED).toBe(false);
    expect(env.EMAIL_PASSWORD_ENABLED).toBe(true);
  });
  it("reports providers.any=false when nothing is configured", () => {
    expect(() => parseEnv(BASE)).not.toThrow(); // email/password off, no social → allowed but flagged
    expect(parseEnv(BASE).providers.any).toBe(false);
  });
  it("has provisioning defaults", () => {
    const env = parseEnv(BASE);
    expect(env.CFN_TEMPLATE_URL).toBe(
      "https://sendsprite-cfn.s3.us-east-1.amazonaws.com/latest/sendsprite-connect.yaml",
    );
    expect(env.AWS_DEFAULT_REGION).toBe("us-east-1");
  });
  it("rejects a non-S3 CFN_TEMPLATE_URL", () => {
    expect(() =>
      parseEnv({
        ...BASE,
        CFN_TEMPLATE_URL: "https://raw.githubusercontent.com/x/y.yaml",
      }),
    ).toThrow(/S3/);
  });
  it("rejects an AWS_DEFAULT_REGION where SES is unavailable", () => {
    expect(() =>
      parseEnv({ ...BASE, AWS_DEFAULT_REGION: "us-gov-west-1" }),
    ).toThrow(/AWS_DEFAULT_REGION/);
    expect(
      parseEnv({ ...BASE, AWS_DEFAULT_REGION: "eu-central-2" })
        .AWS_DEFAULT_REGION,
    ).toBe("eu-central-2");
  });
});

describe("billing env", () => {
  it("is off by default and needs no Polar credentials", () => {
    const e = parseEnv({ ...BASE });
    expect(e.BILLING_ENABLED).toBe(false);
    expect(e.BILLING_PROVIDER).toBe("polar");
    expect(e.BILLING_EVENT_NAME).toBe("email.sent");
  });

  it("refuses BILLING_ENABLED without a token and a webhook secret", () => {
    expect(() => parseEnv({ ...BASE, BILLING_ENABLED: "1" })).toThrow(
      /POLAR_ACCESS_TOKEN/,
    );
    expect(() =>
      parseEnv({ ...BASE, BILLING_ENABLED: "1", POLAR_ACCESS_TOKEN: "t" }),
    ).toThrow(/POLAR_WEBHOOK_SECRET/);
  });

  it("accepts a fully configured sandbox", () => {
    const e = parseEnv({
      ...BASE,
      BILLING_ENABLED: "true",
      POLAR_ACCESS_TOKEN: "polar_oat_x",
      POLAR_WEBHOOK_SECRET: "whsec_x",
      POLAR_SERVER: "sandbox",
      POLAR_METER_ID: "fb2f372a-f6a8-4697-93d6-adab7f76e4ad",
    });
    expect(e.BILLING_ENABLED).toBe(true);
    expect(e.POLAR_SERVER).toBe("sandbox");
    expect(e.POLAR_METER_ID).toBe("fb2f372a-f6a8-4697-93d6-adab7f76e4ad");
  });

  it("the fake provider needs no credentials but is refused in production", () => {
    expect(
      parseEnv({ ...BASE, BILLING_ENABLED: "1", BILLING_PROVIDER: "fake" })
        .BILLING_PROVIDER,
    ).toBe("fake");
    expect(() =>
      parseEnv({
        ...BASE,
        NODE_ENV: "production",
        BILLING_ENABLED: "1",
        BILLING_PROVIDER: "fake",
      }),
    ).toThrow(/BILLING_PROVIDER/);
  });

  it("defaults DEFAULT_PLAN to free and refuses any other value with billing off", () => {
    expect(parseEnv({ ...BASE }).DEFAULT_PLAN).toBe("free");
    expect(() => parseEnv({ ...BASE, DEFAULT_PLAN: "pro" })).toThrow(
      /DEFAULT_PLAN requires BILLING_ENABLED/,
    );
    expect(() => parseEnv({ ...BASE, DEFAULT_PLAN: "gold" })).toThrow();
  });

  it("accepts DEFAULT_PLAN=unlimited with billing on", () => {
    const e = parseEnv({
      ...BASE,
      BILLING_ENABLED: "1",
      BILLING_PROVIDER: "fake",
      DEFAULT_PLAN: "unlimited",
    });
    expect(e.DEFAULT_PLAN).toBe("unlimited");
  });
});
