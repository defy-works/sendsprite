import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Logo, MarkTile } from "@/components/ui/Logo";
import { appVersion, sourceUrl } from "@/lib/build-info";
import type { TeamAws } from "@/services/team-aws";
import { MobileNav } from "./MobileNav";
import { NavLink } from "./NavLink";
import { TeamSwitcher } from "./TeamSwitcher";
import { UserMenu } from "./UserMenu";

const NAV = [
  { href: "/app", label: "Overview" },
  { href: "/app/emails", label: "Emails" },
  { href: "/app/domains", label: "Domains" },
  { href: "/app/api-keys", label: "API keys" },
  { href: "/app/webhooks", label: "Webhooks" },
  { href: "/app/suppressions", label: "Suppressions" },
  { href: "/app/templates", label: "Templates" },
  { href: "/app/contacts", label: "Contacts" },
  { href: "/app/campaigns", label: "Campaigns" },
  { href: "/app/settings", label: "Settings" },
];

/** Appended only for instance admins; everyone else never sees the route. */
const ADMIN_NAV = { href: "/app/admin", label: "Admin" };

export function AppShell(p: {
  teamId: string;
  teamName: string;
  email: string;
  sesStatus: TeamAws["sesAccountStatus"];
  isInstanceAdmin?: boolean;
  children: ReactNode;
}) {
  const nav = p.isInstanceAdmin ? [...NAV, ADMIN_NAV] : NAV;
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-white/10 p-4 md:flex">
        <Link href="/app" aria-label="Sendsprite" className="w-fit">
          <Logo scale={2} />
        </Link>
        <TeamSwitcher activeId={p.teamId} />
        <nav className="flex flex-col gap-1">
          {nav.map((n) => (
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
            <MobileNav>
              <TeamSwitcher activeId={p.teamId} />
              <nav className="flex flex-col gap-1">
                {nav.map((n) => (
                  <NavLink key={n.href} href={n.href} label={n.label} />
                ))}
              </nav>
            </MobileNav>
            <Link href="/app" aria-label="Sendsprite" className="md:hidden">
              <MarkTile scale={1} />
            </Link>
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
        <SourceOffer />
      </div>
    </div>
  );
}

/**
 * The offer of source that AGPL section 13 requires of anyone who runs a
 * modified Sendsprite for other people, sitting next to the version so the
 * two are read together: this build, and where its code lives. Operators
 * point it at their own source with `SOURCE_URL`.
 */
function SourceOffer() {
  return (
    <footer className="flex items-center justify-end gap-2 border-t border-white/5 px-4 py-3 font-mono text-[11px] tracking-[0.08em] text-white/30">
      <span>Sendsprite {appVersion()}</span>
      <span aria-hidden>·</span>
      <a
        href={sourceUrl()}
        target="_blank"
        rel="noreferrer"
        className="hover:text-white/60"
      >
        Source
      </a>
    </footer>
  );
}
