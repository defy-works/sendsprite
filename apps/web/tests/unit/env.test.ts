import { describe, expect, it } from "vitest";
import { parseEnv } from "@/env.schema";
import { UPSTREAM_SOURCE_URL, sourceUrl } from "@/lib/build-info";

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
  it("offers upstream as the source by default (AGPL section 13)", () => {
    // The default is only correct for an unmodified instance; an operator who
    // patches the server points SOURCE_URL at their own source instead.
    expect(parseEnv(BASE).SOURCE_URL).toBe(UPSTREAM_SOURCE_URL);
    expect(parseEnv(BASE).SOURCE_URL).toBe(sourceUrl());
    expect(
      parseEnv({ ...BASE, SOURCE_URL: "https://git.example.com/ss" }),
    ).toHaveProperty("SOURCE_URL", "https://git.example.com/ss");
  });
  it("rejects a SOURCE_URL that is not a URL", () => {
    expect(() => parseEnv({ ...BASE, SOURCE_URL: "git.example.com" })).toThrow(
      /SOURCE_URL/,
    );
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
