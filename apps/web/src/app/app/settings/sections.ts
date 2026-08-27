import type { TeamRole } from "@sendsprite/shared";

export interface SettingsSection {
  id: string;
  label: string;
}

/**
 * The sections of the settings page, in the order they appear on it.
 *
 * Exported rather than built inline because two places need the same list:
 * the page, which renders the sections, and the app shell, which puts them in
 * the sidebar under Settings. Two of them depend on the caller's role and one
 * on whether billing is configured, so a hard-coded copy in the sidebar would
 * offer a member an anchor to a section that is not on their page — a link
 * that scrolls nowhere.
 *
 * The page still guards each section with its own condition at the point it
 * renders it. This decides what is *listed*; that decides what exists.
 */
export function settingsSections(o: {
  role: TeamRole;
  billingEnabled: boolean;
}): SettingsSection[] {
  const isAdmin = o.role === "owner" || o.role === "admin";
  return [
    { id: "team", label: "Team" },
    { id: "members", label: "Members" },
    ...(isAdmin ? [{ id: "sending", label: "Sending" }] : []),
    { id: "retention", label: "Retention" },
    ...(o.billingEnabled ? [{ id: "billing", label: "Billing" }] : []),
    ...(o.role === "owner" ? [{ id: "danger", label: "Danger zone" }] : []),
  ];
}
