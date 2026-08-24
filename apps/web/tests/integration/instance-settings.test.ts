import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
});
afterAll(async () => {
  await pg.stop();
});

describe("instance settings", () => {
  it("creates the singleton lazily", async () => {
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    const s = await getInstanceSettings();
    expect(s.id).toBe(1);
    expect(s.awsMode).toBe("none");
  });
  it("encrypts secrets at rest and decrypts on read", async () => {
    const { updateInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
    const s = await updateInstanceSettings({
      awsMode: "keys",
      awsAccessKey: "AKIAEXAMPLE",
      awsSecret: "s3cr3t",
    });
    expect(s.awsAccessKeyEnc).toMatch(/^v1\./);
    expect(s.awsAccessKeyEnc).not.toContain("AKIA");
    expect(await getDecryptedSecrets()).toMatchObject({
      awsAccessKey: "AKIAEXAMPLE",
      awsSecret: "s3cr3t",
      cloudflareToken: null,
    });
  });
  it("clears a secret when given null", async () => {
    const { updateInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
    const s = await updateInstanceSettings({ awsSecret: null });
    expect(s.awsSecretEnc).toBeNull();
    expect(s.awsAccessKeyEnc).toMatch(/^v1\./);
    expect((await getDecryptedSecrets()).awsSecret).toBeNull();
  });
  it("leaves secrets untouched on a plain patch", async () => {
    const { updateInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
    const before = await updateInstanceSettings({ cloudflareToken: "cf-tok" });
    const after = await updateInstanceSettings({ awsRegion: "eu-west-1" });
    expect(after.awsRegion).toBe("eu-west-1");
    expect(after.awsAccessKeyEnc).toBe(before.awsAccessKeyEnc);
    expect(after.cloudflareTokenEnc).toBe(before.cloudflareTokenEnc);
    expect((await getDecryptedSecrets()).cloudflareToken).toBe("cf-tok");
  });
});
