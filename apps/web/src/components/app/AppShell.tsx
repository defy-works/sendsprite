import type { ReactNode } from "react";
import { appVersion, sourceUrl } from "@/lib/build-info";
import type { TeamAws } from "@/services/team-aws";
import { Sidebar, SidebarNav } from "./Sidebar";
import { TopBar } from "./TopBar";

/**
 * The application chrome: a global bar across the top, a collapsible section
 * rail under it, the page beside that.
 *
 * The bar used to start where the sidebar ended, so the wordmark, the team
 * switcher and the SES badge were all stacked inside the navigation column —
 * three things that scope the *window* living in the part of the window that
 * is about moving between pages. The account menu sat on the other side of the
 * screen from the team it belonged to. This is the arrangement every
 * multi-tenant console lands on instead: instance, tenant and person on one
 * line at the top, and the rail beneath doing one job.
 */
export function AppShell(p: {
  teamId: string;
  teamName: string;
  email: string;
  name: string | null;
  sesStatus: TeamAws["sesAccountStatus"];
  isInstanceAdmin?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        teamId={p.teamId}
        teamName={p.teamName}
        email={p.email}
        name={p.name}
        sesStatus={p.sesStatus}
        isInstanceAdmin={p.isInstanceAdmin}
        drawer={<SidebarNav />}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <main id="main" className="flex-1 p-6">
            {p.children}
          </main>
          <SourceOffer />
        </div>
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
