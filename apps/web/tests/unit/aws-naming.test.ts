import { describe, expect, it } from "vitest";
import {
  awsResourceSuffix,
  configSetName,
  stackName,
  topicName,
} from "@/lib/aws/naming";

describe("awsResourceSuffix", () => {
  it("lowercases and keeps legal characters", () => {
    expect(awsResourceSuffix("Acme-Corp")).toBe("acme-corp");
  });
  it("replaces illegal characters with a hyphen", () => {
    expect(awsResourceSuffix("Acme_Corp!!")).toBe("acme-corp");
  });
  it("collapses runs and trims edge hyphens", () => {
    expect(awsResourceSuffix("--a  b--")).toBe("a-b");
  });
  it("caps at 40 characters without a trailing hyphen", () => {
    const s = awsResourceSuffix("x".repeat(50));
    expect(s).toHaveLength(40);
    expect(s.endsWith("-")).toBe(false);
  });
  it("does not end on a hyphen when the cap lands on one", () => {
    // 40th character is the hyphen, so the trim must run after the slice.
    const s = awsResourceSuffix(`${"x".repeat(39)}-tail`);
    expect(s.endsWith("-")).toBe(false);
  });
  it("falls back when nothing legal survives", () => {
    expect(awsResourceSuffix("!!!")).toBe("team");
    expect(awsResourceSuffix("")).toBe("team");
  });
});

describe("derived names", () => {
  it("builds all three from one suffix", () => {
    expect(stackName("Acme_Corp")).toBe("sendsprite-connect-acme-corp");
    expect(configSetName("Acme_Corp")).toBe("sendsprite-acme-corp");
    expect(topicName("Acme_Corp")).toBe("sendsprite-events-acme-corp");
  });
  it("produces a CloudFormation-legal stack name", () => {
    expect(stackName("9-lives")).toMatch(/^[A-Za-z][A-Za-z0-9-]*$/);
    expect(stackName("!!!")).toMatch(/^[A-Za-z][A-Za-z0-9-]*$/);
  });
  it("gives two different slugs different names", () => {
    expect(configSetName("alpha")).not.toBe(configSetName("beta"));
    expect(topicName("alpha")).not.toBe(topicName("beta"));
  });
});
