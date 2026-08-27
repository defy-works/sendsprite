import type { ReactNode } from "react";
import { appVersion } from "@/lib/build-info";
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
 * The lines that have to agree are set here or in the components this
 * composes: the top bar's bottom edge, the vertical rule between the rail and
 * the page (continued up through the bar by `LogoBlock`), and the collapse
 * control's height, which matches the footer's so the two read as one line
 * when a short page puts them side by side.
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
          {/* The footer scrolls with the page. It sits at the bottom of the
              window when the content is short and leaves with the content when
              it is not — it is not pinned there, which is why it is inside the
              scroll container and not beside it. */}
          <div className="min-w-0 flex-1 overflow-y-auto">
            <div className="flex min-h-full flex-col">
              <main id="main" className="flex-1 p-6">
                {p.children}
              </main>
              <BuildStamp />
            </div>
          </div>
        </div>
      </div>
    </ShellState>
  );
}

/**
 * Which build this is, on every dashboard page. The same value `/api/health`
 * reports as `version`, so a screenshot and a monitor name the same thing.
 */
function BuildStamp() {
  return (
    <footer className="flex h-12 shrink-0 items-center justify-end border-t border-white/5 px-4 font-mono text-[11px] tracking-[0.08em] text-white/30">
      <span>Sendsprite {appVersion()}</span>
    </footer>
  );
}
