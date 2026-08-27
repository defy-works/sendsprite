import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The connect stack's IAM policy against the AWS calls the app actually makes.
 *
 * This exists because the same bug landed twice. `ses:ApplyTrackingConfigurationOverrides`
 * was missing and refused **every** send (bug-016); auditing that turned up
 * `ses:DeleteConfigurationSet` and `sns:DeleteTopic` missing too, which made
 * team deletion leave the config set and topic behind in the customer's
 * account forever (bug-017). Both were invisible until someone exercised the
 * path against real AWS, because a mocked SES client authorises everything.
 *
 * A missing action is not a normal bug: the fix is a template change, a
 * republish to S3, and every existing tenant re-running the stack. So the
 * check belongs at the cheapest possible place instead.
 */

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");
const TEMPLATE = join(
  ROOT,
  "..",
  "..",
  "infra",
  "aws",
  "sendsprite-connect.yaml",
);

/** The SDK package each command comes from decides its IAM service prefix. */
const SERVICE_OF_MODULE: Record<string, string> = {
  "@aws-sdk/client-cloudformation": "cloudformation",
  "@aws-sdk/client-sesv2": "ses",
  "@aws-sdk/client-sns": "sns",
  "@aws-sdk/client-sts": "sts",
};

/**
 * Commands whose IAM action is not simply the command name, or which need a
 * second action beyond it. `SendEmail` carries the tracking override on every
 * call (see services/ses-send.ts), which SES authorises separately.
 */
const EXTRA_ACTIONS: Record<string, readonly string[]> = {
  "ses:SendEmail": ["ses:ApplyTrackingConfigurationOverrides"],
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * Commands the app constructs, paired with the service they belong to. Reads
 * the import statements rather than assuming, so a command name that exists in
 * two SDKs cannot be filed under the wrong service.
 */
function commandsUsed(): Set<string> {
  const actions = new Set<string>();
  for (const file of walk(SRC)) {
    // The fake client names every command in a switch; it issues none.
    if (file.endsWith("fake-client.ts")) continue;
    const source = readFileSync(file, "utf8");
    const constructed = new Set(
      [...source.matchAll(/new (\w+Command)\(/g)].map((m) => m[1]!),
    );
    if (constructed.size === 0) continue;
    for (const [, names, module] of source.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*"(@aws-sdk\/client-[^"]+)"/g,
    )) {
      const service = SERVICE_OF_MODULE[module!];
      if (!service) continue;
      for (const raw of names!.split(",")) {
        const name = raw
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim();
        if (!constructed.has(name)) continue;
        const action = `${service}:${name.replace(/Command$/, "")}`;
        actions.add(action);
        for (const extra of EXTRA_ACTIONS[action] ?? []) actions.add(extra);
      }
    }
  }
  return actions;
}

/**
 * Every action granted by the template. Both spellings count: the `- ses:Foo`
 * bullets under an `Action:` list, and the single-action `Action: sts:Foo`
 * form, which `sts:GetCallerIdentity` uses and an earlier version of this
 * parser missed entirely.
 */
function actionsGranted(): Set<string> {
  const yaml = readFileSync(TEMPLATE, "utf8");
  const action = /([a-z0-9-]+:[A-Za-z0-9]+)/.source;
  return new Set(
    [
      ...yaml.matchAll(new RegExp(String.raw`^\s*-\s+${action}\s*$`, "gm")),
      ...yaml.matchAll(
        new RegExp(String.raw`^\s*Action:\s+${action}\s*$`, "gm"),
      ),
    ].map((m) => m[1]!),
  );
}

describe("connect stack IAM policy", () => {
  it("grants every AWS action the app actually calls", () => {
    const granted = actionsGranted();
    const missing = [...commandsUsed()].filter((a) => !granted.has(a)).sort();
    expect(missing).toEqual([]);
  });

  it("finds the calls at all, so an empty scan cannot pass vacuously", () => {
    const used = commandsUsed();
    expect(used.has("ses:SendEmail")).toBe(true);
    expect(used.has("ses:ApplyTrackingConfigurationOverrides")).toBe(true);
    expect(used.has("sns:DeleteTopic")).toBe(true);
    expect(used.size).toBeGreaterThan(10);
  });

  it("parses the template rather than matching an empty set", () => {
    const granted = actionsGranted();
    expect(granted.has("sts:GetCallerIdentity")).toBe(true);
    expect(granted.size).toBeGreaterThan(15);
  });
});
