import type { ReactNode } from "react";
import {
  IconGauge,
  IconGlobe,
  IconKey,
  IconMail,
  IconMegaphone,
  IconSettings,
  IconShieldOff,
  IconTemplate,
  IconUsers,
  IconWebhook,
} from "@/components/ui/icons";

export interface NavChild {
  /** May carry a fragment: Settings is one long page, not five routes. */
  href: string;
  label: string;
}

export interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  /**
   * Rows that open underneath this one, the way Cloudflare's console nests a
   * section's pages under the section.
   *
   * Settings used to grow its own sticky rail beside the app's, so the page
   * had two navigation columns side by side — one for the app, one for the
   * page, neither obviously in charge. The section list belongs in the
   * sidebar with everything else navigable.
   */
  children?: readonly NavChild[];
}

export interface NavGroup {
  /** `null` for the ungrouped rows at the very top and bottom. */
  label: string | null;
  items: NavItem[];
}

/**
 * The sidebar, grouped by what somebody is trying to do.
 *
 * It was a flat list of ten links in the order the features happened to be
 * built, which made "where do I add a domain" a scan of the whole column every
 * time. Three groups name the three jobs — get mail out, decide who receives
 * it, wire the account up — and Overview and Settings sit outside them because
 * they are not part of any one job.
 *
 * **Admin is deliberately absent.** Instance administration is a different
 * product surface with a different blast radius: it is at `/admin`, reached
 * from the account menu, so nobody edits an instance-wide setting because they
 * misread which row of one sidebar they were on.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: null,
    items: [{ href: "/app", label: "Overview", icon: <IconGauge /> }],
  },
  {
    label: "Send",
    items: [
      { href: "/app/emails", label: "Emails", icon: <IconMail /> },
      { href: "/app/campaigns", label: "Campaigns", icon: <IconMegaphone /> },
      { href: "/app/templates", label: "Templates", icon: <IconTemplate /> },
    ],
  },
  {
    label: "Audience",
    items: [
      { href: "/app/contacts", label: "Contacts", icon: <IconUsers /> },
      {
        href: "/app/suppressions",
        label: "Suppressions",
        icon: <IconShieldOff />,
      },
    ],
  },
  {
    label: "Configure",
    items: [
      { href: "/app/domains", label: "Domains", icon: <IconGlobe /> },
      { href: "/app/api-keys", label: "API keys", icon: <IconKey /> },
      { href: "/app/webhooks", label: "Webhooks", icon: <IconWebhook /> },
    ],
  },
  {
    label: null,
    items: [
      {
        href: "/app/settings",
        label: "Settings",
        icon: <IconSettings />,
        // The ids these point at are the `<Section>` ids on the settings page.
        // Two of them are conditional there (Sending needs an admin, Danger
        // zone an owner) and an anchor to a section that is not rendered just
        // scrolls nowhere, which is a better failure than a sidebar whose rows
        // depend on a role the sidebar does not know.
        children: [
          { href: "/app/settings#team", label: "Team" },
          { href: "/app/settings#members", label: "Members" },
          { href: "/app/settings#sending", label: "Sending" },
          { href: "/app/settings#retention", label: "Retention" },
          { href: "/app/settings#billing", label: "Billing" },
          { href: "/app/settings#danger", label: "Danger zone" },
        ],
      },
    ],
  },
];
