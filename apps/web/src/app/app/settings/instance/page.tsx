import { redirect } from "next/navigation";

/**
 * Renamed in the org-level-connections phase: the page is a team's own AWS
 * and Cloudflare connection now, not an instance-wide one. Operator settings
 * moved to /app/admin.
 */
export default function InstanceSettingsRedirect() {
  redirect("/app/settings/sending");
}
