import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "@/lib/cloudflare/client";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
});
afterAll(async () => {
  await pg.stop();
});
/** Every test starts from a disconnected instance. */
beforeEach(async () => {
  const { updateInstanceSettings } =
    await import("@/services/instance-settings");
  await updateInstanceSettings(
    {
      cloudflareToken: null,
      cloudflareConnectedAt: null,
      cloudflareAccountName: null,
    },
    undefined,
    { audit: false },
  );
});

const okFetch: FetchLike = async (url) => {
  if (String(url).includes("/user/tokens/verify"))
    return new Response(
      JSON.stringify({ success: true, result: { status: "active" } }),
    );
  if (String(url).includes("/zones"))
    return new Response(
      JSON.stringify({
        success: true,
        result: [{ id: "z1", name: "acme.com" }],
      }),
    );
  return new Response("{}", { status: 404 });
};

describe("connectCloudflare", () => {
  it("validates the token, stores it encrypted and lists zones", async () => {
    const { connectCloudflare, listZones, disconnectCloudflare } =
      await import("@/services/cloudflare-connect");
    const res = await connectCloudflare(
      "cf-token-value-0123456789",
      { userId: "u1" },
      okFetch,
    );
    expect(res).toMatchObject({
      ok: true,
      data: { zones: [{ id: "z1", name: "acme.com" }] },
    });
    const { getInstanceSettings, getDecryptedSecrets } =
      await import("@/services/instance-settings");
    const s = await getInstanceSettings();
    expect(s.cloudflareTokenEnc).toMatch(/^v1\./);
    expect(s.cloudflareAccountName).toBe("acme.com");
    expect(s.cloudflareConnectedAt).toBeInstanceOf(Date);
    expect((await getDecryptedSecrets()).cloudflareToken).toBe(
      "cf-token-value-0123456789",
    );
    expect(await listZones(okFetch)).toEqual([{ id: "z1", name: "acme.com" }]);

    await disconnectCloudflare({ userId: "u1" });
    expect((await getInstanceSettings()).cloudflareTokenEnc).toBeNull();
    expect(await listZones(okFetch)).toEqual([]);
  });

  it("returns an error for an invalid token and stores nothing", async () => {
    const { connectCloudflare } = await import("@/services/cloudflare-connect");
    const bad: FetchLike = async () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: "Invalid API Token" }],
        }),
        { status: 401 },
      );
    const res = await connectCloudflare(
      "bad-token-0123456789",
      { userId: "u1" },
      bad,
    );
    expect(res).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Invalid API Token/),
      code: "1000",
    });
    const { getInstanceSettings } =
      await import("@/services/instance-settings");
    expect((await getInstanceSettings()).cloudflareTokenEnc).toBeNull();

    expect(
      await connectCloudflare("short", { userId: "u1" }, bad),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Paste the API token/),
    });
  });
});
