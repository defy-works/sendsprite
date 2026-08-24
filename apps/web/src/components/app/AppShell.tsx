import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import type { InstanceSettings } from "@/services/instance-settings";
import { NavLink } from "./NavLink";
import { TeamSwitcher } from "./TeamSwitcher";
import { UserMenu } from "./UserMenu";

const NAV = [
  { href: "/app", label: "Overview" },
  { href: "/app/emails", label: "Emails" },
  { href: "/app/domains", label: "Domains" },
  { href: "/app/api-keys", label: "API keys" },
  { href: "/app/webhooks", label: "Webhooks" },
  { href: "/app/templates", label: "Templates" },
  { href: "/app/contacts", label: "Contacts" },
  { href: "/app/campaigns", label: "Campaigns" },
  { href: "/app/settings", label: "Settings" },
];

export function AppShell(p: {
  teamId: string;
  teamName: string;
  email: string;
  sesStatus: InstanceSettings["sesAccountStatus"];
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-white/10 p-4 md:flex">
        <Link href="/app" className="num-stamp">
          Sendsprite
        </Link>
        <TeamSwitcher activeId={p.teamId} />
        <nav className="flex flex-col gap-1">
          {NAV.map((n) => (
            <NavLink key={n.href} href={n.href} label={n.label} />
          ))}
        </nav>
        <div className="mt-auto">
          {p.sesStatus === "production" ? (
            <Badge variant="success">SES production</Badge>
          ) : p.sesStatus === "requested" ? (
            <Badge variant="warning">SES review pending</Badge>
          ) : p.sesStatus === "sandbox" ? (
            <Badge variant="warning">SES sandbox</Badge>
          ) : (
            <Badge variant="muted">AWS not connected</Badge>
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex h-14 items-center justify-between border-b border-white/10 px-4">
          <div className="flex items-center gap-3">
            {/* Mobile nav: native <details> so it needs no client JS. */}
            <details className="group md:hidden">
              <summary
                aria-label="Menu"
                className="cursor-pointer list-none rounded-md px-2 py-1 text-sm text-white/75 hover:bg-white/6 hover:text-white"
              >
                ☰
              </summary>
              <div className="absolute top-14 left-0 z-20 flex w-64 flex-col gap-4 border-r border-b border-white/10 bg-shadow p-4">
                <TeamSwitcher activeId={p.teamId} />
                <nav className="flex flex-col gap-1">
                  {NAV.map((n) => (
                    <NavLink key={n.href} href={n.href} label={n.label} />
                  ))}
                </nav>
              </div>
            </details>
            <span className="text-sm text-white/60">{p.teamName}</span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/docs"
              className="text-sm text-white/60 hover:text-white"
            >
              Docs
            </Link>
            <UserMenu email={p.email} />
          </div>
        </header>
        <main className="flex-1 p-6">{p.children}</main>
      </div>
    </div>
  );
}
