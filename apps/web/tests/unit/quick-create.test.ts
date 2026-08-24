import { describe, expect, it } from "vitest";
import { buildQuickCreateUrl } from "@/lib/aws/quick-create";

const base = {
  region: "eu-west-1",
  templateUrl:
    "https://sendsprite-cfn.s3.us-east-1.amazonaws.com/latest/sendsprite-connect.yaml",
  callbackUrl: "https://mail.acme.com/api/setup/aws/callback",
  callbackToken: "abc123",
  stackName: "sendsprite-connect",
};

describe("buildQuickCreateUrl", () => {
  const url = buildQuickCreateUrl(base);
  it("targets the region's console and the quick-create review page", () => {
    expect(
      url.startsWith(
        "https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/create/review?",
      ),
    ).toBe(true);
  });
  it("carries template, stack name and both params URL-encoded", () => {
    const q = new URLSearchParams(url.split("#/stacks/create/review?")[1]);
    expect(q.get("templateURL")).toBe(base.templateUrl);
    expect(q.get("stackName")).toBe("sendsprite-connect");
    expect(q.get("param_CallbackUrl")).toBe(
      "https://mail.acme.com/api/setup/aws/callback",
    );
    expect(q.get("param_CallbackToken")).toBe("abc123");
  });
  it("accepts path-style S3 urls", () => {
    expect(() =>
      buildQuickCreateUrl({
        ...base,
        templateUrl: "https://s3.eu-west-1.amazonaws.com/bucket/t.yaml",
      }),
    ).not.toThrow();
  });
  it("rejects a non-S3 template url", () => {
    for (const templateUrl of [
      "https://example.com/t.yaml",
      "https://raw.githubusercontent.com/x/y/main/t.yaml",
    ]) {
      expect(() => buildQuickCreateUrl({ ...base, templateUrl })).toThrow(/S3/);
    }
  });
});
