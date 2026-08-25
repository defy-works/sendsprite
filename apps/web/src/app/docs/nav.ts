/** Sidebar order for `/docs`; also the reading order the pages assume. */
export interface DocsNavItem {
  title: string;
  href: string;
  /** Shown next to the link while the underlying feature has not shipped. */
  soon?: boolean;
}

export const DOCS_NAV: DocsNavItem[] = [
  { title: "Getting started", href: "/docs" },
  { title: "Self-hosting", href: "/docs/self-hosting" },
  { title: "Domains", href: "/docs/domains" },
  { title: "Sending", href: "/docs/sending" },
  { title: "API keys", href: "/docs/api-keys" },
  { title: "Webhooks", href: "/docs/webhooks" },
  { title: "Billing", href: "/docs/billing" },
  { title: "SDK", href: "/docs/sdk" },
  { title: "CLI", href: "/docs/cli" },
  { title: "MCP server", href: "/docs/mcp" },
  { title: "API reference", href: "/docs/api" },
];
