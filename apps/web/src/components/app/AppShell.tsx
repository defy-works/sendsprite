import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/Badge";
import { Logo, MarkTile } from "@/components/ui/Logo";
import { IconExternal } from "@/components/ui/icons";
import { appVersion, sourceUrl } from "@/lib/build-info";
import type { TeamAws } from "@/services/team-aws";
import { MobileNav } from "./MobileNav";
import { NAV_GROUPS } from "./nav";
import { NavLink } from "./NavLink";
import { TeamSwitcher } from "./TeamSwitcher";
import { UserMenu } from "./UserMenu";

export function AppShell(p: {
  teamId: string;
  teamName: string;
  email: string;
  name: string | null;
  sesStatus: TeamAws["sesAccountStatus"];
  isInstanceAdmin?: boolean;
  children: ReactNode;
}) {
  const nav = (
    <nav className="flex flex-col gap-5" aria-label="Sections">
      {NAV_GROUPS.map((g) => (
        <div key={g.label ?? "root"} className="flex flex-col gap-0.5">
          {g.label && <p className="num-stamp px-3 pb-1.5">{g.label}</p>}
          {g.items.map((n) => (
            <NavLink key={n.href} {...n} />
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-white/10 p-4 md:flex">
        <Link href="/app" aria-label="Sendsprite" className="w-fit px-1 pt-1">
          <Logo scale={2} />
        </Link>
        <TeamSwitcher activeId={p.teamId} activeName={p.teamName} />
        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">{nav}</div>
        <SesBadge status={p.sesStatus} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-white/10 bg-ink/80 px-4 backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-3">
            <MobileNav>
              <TeamSwitcher activeId={p.teamId} activeName={p.teamName} />
              {nav}
            </MobileNav>
            <Link href="/app" aria-label="Sendsprite" className="md:hidden">
              <MarkTile scale={1} />
            </Link>
            <span className="truncate text-sm text-white/55 md:hidden">
              {p.teamName}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {/* Opens in a new tab: the docs are reference material read
                *while* configuring something, and replacing the page the
                reader is configuring is exactly the wrong move. */}
            <a
              href="/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-white/60 transition-colors hover:bg-white/6 hover:text-white sm:inline-flex"
            >
              Docs
              <IconExternal className="text-xs opacity-70" />
            </a>
            <UserMenu
              email={p.email}
              name={p.name}
              isInstanceAdmin={p.isInstanceAdmin}
            />
          </div>
        </header>
        <main id="main" className="flex-1 p-6">
          {p.children}
        </main>
        <SourceOffer />
      </div>
    </div>
  );
}

function SesBadge({ status }: { status: TeamAws["sesAccountStatus"] }) {
  return (
    <div className="shrink-0">
      {status === "production" ? (
        <Badge variant="success">SES production</Badge>
      ) : status === "requested" ? (
        <Badge variant="warning">SES review pending</Badge>
      ) : status === "sandbox" ? (
        <Badge variant="warning">SES sandbox</Badge>
      ) : (
        <Badge variant="muted">AWS not connected</Badge>
      )}
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
