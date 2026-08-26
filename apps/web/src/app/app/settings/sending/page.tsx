import { redirect } from "next/navigation";

/**
 * Sending moved onto the Settings page itself.
 *
 * The redirect stays because this path was linked from the dashboard banner,
 * the setup wizard, the Cloudflare OAuth `from` parameter and, more to the
 * point, from whatever anyone bookmarked. The query string is carried across
 * rather than dropped: an OAuth failure comes back as `?error=access_denied`,
 * and losing it here would land the user on a Settings page that silently
 * showed Cloudflare as still disconnected with no reason given.
 */
export default async function SendingSettingsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === "string") params.set(k, v);
    else if (Array.isArray(v)) for (const one of v) params.append(k, one);
  }
  const query = params.toString();
  redirect(`/app/settings${query ? `?${query}` : ""}#sending`);
}
