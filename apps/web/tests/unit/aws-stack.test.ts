import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseStackArn, stackConsoleUrl } from "@/lib/aws/stack";

const ARN =
  "arn:aws:cloudformation:ap-northeast-1:582071018365:stack/sendsprite-connect-defy-works/3f1c2a10-9b7e-11ef-8c2d-0a1b2c3d4e5f";

describe("parseStackArn", () => {
  it("splits a stack ARN into region, account and name", () => {
    expect(parseStackArn(ARN)).toEqual({
      region: "ap-northeast-1",
      accountId: "582071018365",
      name: "sendsprite-connect-defy-works",
    });
  });
  it("returns null for anything else", () => {
    for (const bad of [
      "",
      "sendsprite-connect-defy-works",
      "arn:aws:iam::582071018365:user/sendsprite-x",
      "arn:aws:cloudformation:ap-northeast-1:582071018365:stack/name",
    ])
      expect(parseStackArn(bad)).toBeNull();
  });
});

describe("stackConsoleUrl", () => {
  it("links to the stack's events tab in its own region", () => {
    const url = stackConsoleUrl(ARN)!;
    expect(
      url.startsWith("https://ap-northeast-1.console.aws.amazon.com/"),
    ).toBe(true);
    expect(url).toContain("#/stacks/events?stackId=");
    expect(decodeURIComponent(url.split("stackId=")[1]!)).toBe(ARN);
  });
  it("is null when the ARN does not parse", () => {
    expect(stackConsoleUrl("nope")).toBeNull();
  });
});

/**
 * The template's deletion order is load-bearing: `ServiceRole` is what
 * CloudFormation assumes to delete the other resources, so it has to go
 * last, which means every other resource must depend on it — by an explicit
 * `DependsOn` or by referencing it. Nothing else would catch that line being
 * dropped; the stack would just start landing in DELETE_FAILED.
 */
describe("connect template deletion order", () => {
  const yaml = readFileSync(
    join(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "infra",
      "aws",
      "sendsprite-connect.yaml",
    ),
    "utf8",
  );
  const resources = yaml.slice(
    yaml.indexOf("\nResources:"),
    yaml.indexOf("\nOutputs:"),
  );
  const blocks = resources.split(/\n {2}(?=[A-Z]\w+:\n)/).slice(1);

  it("has every resource other than ServiceRole depend on it", () => {
    const names = blocks.map((b) => b.split(":")[0]!);
    expect(names).toContain("ServiceRole");
    for (const block of blocks) {
      const name = block.split(":")[0]!;
      if (name === "ServiceRole") continue;
      const depends =
        /^\s+DependsOn: ServiceRole$/m.test(block) ||
        /!GetAtt ServiceRole\.Arn/.test(block);
      expect(depends, `${name} must depend on ServiceRole`).toBe(true);
    }
  });

  it("passes the stack id and the service role to the callback", () => {
    expect(yaml).toMatch(/StackId: !Ref AWS::StackId/);
    expect(yaml).toMatch(/ServiceRoleArn: !GetAtt ServiceRole\.Arn/);
    expect(yaml).toMatch(/"stackId": p\["StackId"\]/);
    expect(yaml).toMatch(/"serviceRoleArn": p\["ServiceRoleArn"\]/);
  });
});
