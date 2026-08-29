import { env } from "@/env";
import { getInstanceSettings } from "@/services/instance-settings";

/**
 * Whether this instance serves the public marketing pages (`/`,
 * `/alternatives/*`, the sitemap). The instance setting wins; the env value
 * is the fallback while it is unset. A self-hosted instance normally turns
 * the landing off, and with it every page that only makes sense on
 * sendsprite.com.
 */
export async function isLandingEnabled(): Promise<boolean> {
  const s = await getInstanceSettings();
  return s.landingEnabled ?? env.LANDING_ENABLED;
}

/** Absolute origin of this instance, for canonicals, OG tags and the sitemap. */
export function siteOrigin(): string {
  return env.APP_URL.replace(/\/$/, "");
}
