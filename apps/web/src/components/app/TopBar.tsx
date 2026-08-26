import Link from "next/link";
import { Logo, MarkTile } from "@/components/ui/Logo";
import { IconExternal } from "@/components/ui/icons";
import type { TeamAws } from "@/services/team-aws";
import { MobileNav } from "./MobileNav";
import { SesPill } from "./SesPill";
import { TeamSwitcher } from "./TeamSwitcher";
import { UserMenu } from "./UserMenu";
import type { ReactNode } from "react";

/**
 * The global bar: who you are, which team you are in, and the way out to the
 * docs and the account.
 *
 * It spans the full width, above the sidebar rather than beside it, which is
 * the arrangement every console with more than one tenant converges on
 * (Cloudflare, Vercel, AWS) for the same reason: the team you are acting as is
 * a property of the whole window, not of the navigation column. It used to be
 * a bordered control *inside* the sidebar, level with the section links, which
 * read as an eleventh place to navigate to rather than as the context
 * everything below it is scoped by — and it took a sidebar row's worth of
 * height on every page to say something that changes twice a year.
 *
 * The wordmark, the team and the account sit on one line, left to right in
 * that order: instance, tenant, person.
 */
export function TopBar(p: {
  teamId: string;
  teamName: string;
  email: string;
  name: string | null;
  sesStatus: TeamAws["sesAccountStatus"];
  isInstanceAdmin?: boolean;
  /** The sidebar's contents, for the drawer on a narrow screen. */
  drawer: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-13 shrink-0 items-center gap-1 border-b border-white/10 bg-ink/85 px-3 backdrop-blur-md">
      <MobileNav>
        <TeamSwitcher
          activeId={p.teamId}
          activeName={p.teamName}
          variant="panel"
        />
        {p.drawer}
      </MobileNav>

      <Link
        href="/app"
        aria-label="Sendsprite"
        className="flex shrink-0 items-center rounded-md px-1.5 py-1 transition-opacity hover:opacity-80"
      >
        <MarkTile scale={1.15} className="md:hidden" />
        <Logo scale={1.9} className="hidden md:block" />
      </Link>

      {/* The same separator Cloudflare and Vercel use between the instance and
          the tenant: a hairline slash, not a border, so the two read as one
          path rather than as two controls that happen to be adjacent. */}
      <span aria-hidden className="hidden px-1 text-lg text-white/15 sm:block">
        /
      </span>
      <div className="hidden min-w-0 sm:block">
        <TeamSwitcher activeId={p.teamId} activeName={p.teamName} />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <SesPill status={p.sesStatus} />
        {/* A new tab: the docs are read *while* configuring something, and
            replacing the page being configured is exactly the wrong move. */}
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
  );
}
