import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusDot } from "@/components/ui/StatusDot";
import { IconSearch } from "@/components/ui/icons";
import { requireInstanceAdmin } from "@/lib/session";
import { listOrganizations } from "@/services/admin";

export const metadata = { title: "Organizations" };

const date = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireInstanceAdmin();
  const q = (await searchParams).q ?? "";
  const orgs = await listOrganizations(q);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Organizations"
        description="Every team on this instance. Open one to override its limits, suspend its sending, or read its connection."
      />

      {/* A GET form, so a search is a URL: linkable, back-button-able, and
          rendered on the server without shipping the whole list to filter it. */}
      <form method="get" className="relative max-w-sm">
        <IconSearch className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-white/35" />
        <Input
          name="q"
          defaultValue={q}
          placeholder="Search by name or slug"
          aria-label="Search organizations"
          className="pl-9"
        />
      </form>

      {orgs.length === 0 ? (
        <EmptyState
          eyebrow={q ? "No match" : "Nothing here yet"}
          title={q ? `Nothing matches "${q}"` : "No teams yet"}
          body={
            q
              ? "Search matches the team name and slug."
              : "The first person to sign up creates the first team."
          }
        />
      ) : (
        <div className="glass overflow-x-auto p-0">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left">
                <Th>Team</Th>
                <Th>Members</Th>
                <Th>Domains</Th>
                <Th className="text-right">Sent · 30d</Th>
                <Th>Sending</Th>
                <Th>Plan</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o, i) => (
                <tr
                  key={o.id}
                  className="fade-up border-b border-white/5 transition-colors last:border-0 hover:bg-white/4"
                  // Staggered, but capped: past a dozen rows the delay stops
                  // reading as sequence and starts reading as lag.
                  style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/organizations/${o.id}`}
                      className="font-medium no-underline hover:text-indigo-300"
                    >
                      {o.name}
                    </Link>
                    <p className="font-mono text-xs text-white/40">{o.slug}</p>
                  </td>
                  <td className="tnum px-4 py-3 text-white/70">{o.members}</td>
                  <td className="tnum px-4 py-3 text-white/70">{o.domains}</td>
                  <td className="tnum px-4 py-3 text-right text-white/70">
                    {o.sent30d.toLocaleString("en-US")}
                  </td>
                  <td className="px-4 py-3">
                    {o.suspendedAt ? (
                      <Badge variant="danger">Suspended</Badge>
                    ) : !o.awsConnected ? (
                      <StatusDot status="off" label="No AWS" />
                    ) : o.sesStatus === "production" ? (
                      <StatusDot status="ok" label="Production" />
                    ) : o.sesStatus === "requested" ? (
                      <StatusDot status="pending" label="In review" />
                    ) : (
                      <StatusDot status="warning" label="Sandbox" />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={
                        o.planOverride || (o.plan && o.plan !== "free")
                          ? "indigo"
                          : "muted"
                      }
                    >
                      {o.planOverride
                        ? `${o.planOverride} (granted)`
                        : (o.plan ?? "free")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-white/55">
                    {date(o.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-4 py-2.5 text-[11px] font-medium tracking-[0.14em] text-white/40 uppercase ${className ?? ""}`}
    >
      {children}
    </th>
  );
}
