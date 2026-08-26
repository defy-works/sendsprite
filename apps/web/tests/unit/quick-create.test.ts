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
  // The console percent-decodes `param_*` values, so URLSearchParams encoding round-trips.
  it("carries template, stack name and both params URL-encoded", () => {
    const q = new URLSearchParams(url.split("#/stacks/create/review?")[1]);
    expect(q.get("templateURL")).toBe(base.templateUrl);
    expect(q.get("stackName")).toBe("sendsprite-connect");
    expect(q.get("param_CallbackUrl")).toBe(
      "https://mail.acme.com/api/setup/aws/callback",
    );
    expect(q.get("param_CallbackToken")).toBe("abc123");
  });
  it("accepts path-style regional and virtual-hosted global S3 urls", () => {
    for (const templateUrl of [
      "https://s3.eu-west-1.amazonaws.com/bucket/t.yaml",
      "https://b.s3.amazonaws.com/x.yaml",
    ]) {
      expect(() => buildQuickCreateUrl({ ...base, templateUrl })).not.toThrow();
    }
  });
  it("rejects non-S3 and look-alike template urls", () => {
    for (const templateUrl of [
      "https://example.com/t.yaml",
      "https://raw.githubusercontent.com/x/y/main/t.yaml",
      "https://evil.com/s3.amazonaws.com/x.yaml",
      "https://b.s3.amazonaws.com.evil.com/x.yaml",
      "http://b.s3.amazonaws.com/x.yaml",
    ]) {
      expect(() => buildQuickCreateUrl({ ...base, templateUrl })).toThrow(/S3/);
    }
  });
});
