import {
  CloudflareClient,
  CloudflareError,
  type CfZone,
  type FetchLike,
} from "@/lib/cloudflare/client";
import type { Result } from "@/lib/result";
import {
  getDecryptedSecrets,
  updateInstanceSettings,
  type InstanceActor,
} from "./instance-settings";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const errCode = (e: unknown) =>
  e instanceof CloudflareError && e.code !== undefined
    ? String(e.code)
    : undefined;

/** Verify a pasted API token, store it encrypted and return the zones it can see. */
export async function connectCloudflare(
  token: string,
  actor: InstanceActor,
  f: FetchLike = fetch,
): Promise<Result<{ zones: CfZone[] }>> {
  if (typeof token !== "string" || token.trim().length < 10)
    return { ok: false, error: "Paste the API token Cloudflare showed you." };
  const trimmed = token.trim();
  const cf = new CloudflareClient(trimmed, f);
  try {
    const v = await cf.verifyToken();
    if (v.status !== "active")
      return { ok: false, error: `Token status is ${v.status}.` };
    const zones = await cf.listZones();
    await updateInstanceSettings(
      {
        cloudflareToken: trimmed,
        cloudflareConnectedAt: new Date(),
        cloudflareAccountName: zones[0]?.name ?? null,
      },
      actor,
    );
    return { ok: true, data: { zones } };
  } catch (e) {
    return {
      ok: false,
      error: `Cloudflare rejected the token: ${errMsg(e)}`,
      code: errCode(e),
    };
  }
}

export async function disconnectCloudflare(
  actor: InstanceActor,
): Promise<Result> {
  await updateInstanceSettings(
    {
      cloudflareToken: null,
      cloudflareConnectedAt: null,
      cloudflareAccountName: null,
    },
    actor,
  );
  return { ok: true, data: undefined };
}

/** Client bound to the stored token, or null when Cloudflare isn't connected. */
export async function cloudflareClient(
  f: FetchLike = fetch,
): Promise<CloudflareClient | null> {
  const { cloudflareToken } = await getDecryptedSecrets();
  return cloudflareToken ? new CloudflareClient(cloudflareToken, f) : null;
}

export async function listZones(f: FetchLike = fetch): Promise<CfZone[]> {
  const cf = await cloudflareClient(f);
  return cf ? cf.listZones() : [];
}
