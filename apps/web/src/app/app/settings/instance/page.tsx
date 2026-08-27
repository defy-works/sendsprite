import { redirect } from "next/navigation";

/**
 * Renamed in the org-level-connections phase: the page is a team's own AWS
 * and Cloudflare connection now, not an instance-wide one. Operator settings
 * moved to /admin. Kept as a redirect because the path was linked and
 * bookmarked; it points at the route that replaced the `#sending` anchor.
 */
export default function InstanceSettingsRedirect() {
  redirect("/app/settings/sending");
}
