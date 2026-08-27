import Link from "next/link";
import type { ReactNode } from "react";
import { MarkTile } from "@/components/ui/Logo";
import { IconArrowLeft, IconExternal } from "@/components/ui/icons";
import { requireInstanceAdmin } from "@/lib/session";
import { AdminNav } from "./AdminNav";

export const metadata = { title: "Instance admin" };

/**
 * The instance admin area, at `/admin` rather than `/app/admin`.
 *
 * It was a row in the team sidebar, which put "change the signup mode for
 * every account on this deployment" one line below "Settings" — two clicks
 * apart, in the same list, in the same colours. The two surfaces answer to
 * different people and have different blast radii, and the interface should
 * make it obvious which one you are in.
 *
 * So this shell is deliberately not the app shell: a red hairline and rail
 * instead of indigo, no team switcher (nothing here is team-scoped), and a
 * standing link back to the dashboard. Everything under it is gated by
 * `requireInstanceAdmin`, which the pages also call — a layout is not an
 * authorisation boundary in the app router, because a page can be requested
 * on its own.
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const s = await requireInstanceAdmin();
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-danger/25 bg-ink/85 px-4 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-3">
          <MarkTile scale={1} />
          <span className="rounded-full border border-danger/40 bg-danger/12 px-2.5 py-0.5 font-mono text-[10px] tracking-[0.18em] text-red-200 uppercase">
            Instance admin
          </span>
          <span className="hidden truncate text-sm text-white/45 sm:inline">
            {s.user.email}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <a
            href="/docs/self-hosting"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-white/55 transition-colors hover:bg-white/6 hover:text-white sm:inline-flex"
          >
            Self-hosting docs
            <IconExternal className="text-xs opacity-70" />
          </a>
          <Link
            href="/app"
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-white/60 no-underline transition-colors hover:bg-white/6 hover:text-white"
          >
            <IconArrowLeft className="text-xs" />
            Back to dashboard
          </Link>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-6">
        <AdminNav />
        {children}
      </div>
    </div>
  );
}
