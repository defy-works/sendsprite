import type { ReactNode } from "react";
import { appVersion, sourceUrl } from "@/lib/build-info";
import type { TeamAws } from "@/services/team-aws";
import type { NavChild } from "./nav";
import { ShellState } from "./ShellState";
import { Sidebar, SidebarNav } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * The application chrome: a global bar across the top, a section rail under
 * it, the page beside that.
 *
 * The window is fixed (`h-dvh`, `overflow-hidden`) and the two columns scroll
 * themselves. Before, the whole document scrolled, so a long page dragged the
 * sidebar's foot off the bottom of the screen with it — a navigation column
 * that leaves the screen is not navigation, and the collapse control went with
 * it.
 *
 * Three horizontal rules have to agree, and all three are set here or in the
 * components this composes: the top bar's bottom edge, the vertical line
 * between the rail and the page (continued up through the bar by `LogoBlock`),
 * and the bottom rail, where the collapse control and the footer are the same
 * height so their top borders read as one line.
 */
export function AppShell(p: {
  teamId: string;
  teamName: string;
  email: string;
  name: string | null;
  sesStatus: TeamAws["sesAccountStatus"];
  isInstanceAdmin?: boolean;
  /** Settings' own sections, listed under it in the rail. */
  settingsChildren?: readonly NavChild[];
  children: ReactNode;
}) {
  return (
    <ShellState>
      <div className="flex h-dvh flex-col overflow-hidden">
        <TopBar
          teamId={p.teamId}
          teamName={p.teamName}
          email={p.email}
          name={p.name}
          sesStatus={p.sesStatus}
          isInstanceAdmin={p.isInstanceAdmin}
          drawer={<SidebarNav settingsChildren={p.settingsChildren} />}
        />
        <div className="flex min-h-0 flex-1">
          <Sidebar settingsChildren={p.settingsChildren} />
          <div className="flex min-w-0 flex-1 flex-col">
            <main id="main" className="min-h-0 flex-1 overflow-y-auto p-6">
              {p.children}
            </main>
            <SourceOffer />
          </div>
        </div>
      </div>
    </ShellState>
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
    <footer className="flex h-12 shrink-0 items-center justify-end gap-2 border-t border-white/5 px-4 font-mono text-[11px] tracking-[0.08em] text-white/30">
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
