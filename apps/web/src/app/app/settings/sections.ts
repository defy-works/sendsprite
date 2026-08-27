import type { TeamRole } from "@sendsprite/shared";

export interface SettingsSection {
  href: string;
  label: string;
}

/**
 * The settings pages, in the order the sidebar lists them.
 *
 * Exported rather than written into the nav data because two of the four
 * depend on the caller: Sending is admin-only and `notFound`s for anyone else,
 * and Billing exists only where billing is configured. A hard-coded list in
 * the sidebar would offer a member a row that 404s.
 *
 * Retention and the danger zone are not here — they are on the General page,
 * being one number and one button respectively.
 */
export function settingsSections(o: {
  role: TeamRole;
  billingEnabled: boolean;
}): SettingsSection[] {
  const isAdmin = o.role === "owner" || o.role === "admin";
  return [
    { href: "/app/settings", label: "General" },
    { href: "/app/settings/members", label: "Members" },
    ...(isAdmin ? [{ href: "/app/settings/sending", label: "Sending" }] : []),
    ...(o.billingEnabled
      ? [{ href: "/app/settings/billing", label: "Billing" }]
      : []),
  ];
}
