import NextLink from "next/link";
import { can } from "@sendsprite/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Link } from "@/components/ui/Link";
import { StatusDot, type Status } from "@/components/ui/StatusDot";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { listDomains, type Domain } from "@/services/domains";
import { getTeamAws } from "@/services/team-aws";
import { Notice } from "@/app/setup/steps/shared";

export const metadata = { title: "Domains" };

const DOT: Record<Domain["status"], Status> = {
  pending: "pending",
  verified: "ok",
  failed: "error",
};

export default async function DomainsPage() {
  const ctx = await requireTeam();
  const [rows, aws] = await Promise.all([
    listDomains(ctx.team.id),
    getTeamAws(ctx.team.id),
  ]);
  const addButton = can(ctx.role, "domains.manage") ? (
    <Button asChild>
      <NextLink href="/app/domains/new">Add domain</NextLink>
    </Button>
  ) : null;
  return (
    <div className="flex flex-col gap-6">
      {!aws && (
        <Notice>
          AWS is not connected, so domains cannot be provisioned.{" "}
          {ctx.role === "owner" || ctx.role === "admin" ? (
            <Link href="/app/settings/sending">Connect AWS in Settings</Link>
          ) : (
            "Ask a team owner or admin to connect it in Settings → Sending."
          )}
        </Notice>
      )}
      {rows.length === 0 ? (
        <EmptyState
          title="Add your first sending domain"
          body="Sendsprite creates the SES identity and tells you (or Cloudflare) which DNS records to add, then verifies them."
          action={addButton}
        />
      ) : (
        <>
          {addButton && <div className="flex justify-end">{addButton}</div>}
          <div className="glass overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="num-stamp text-left">
                <tr>
                  <th className="px-4 py-3 font-medium">Domain</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">DNS</th>
                  <th className="px-4 py-3 font-medium">Region</th>
                  <th className="px-4 py-3 font-medium">Last checked</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className="border-t border-white/8">
                    <td className="px-4 py-3 font-medium">{d.name}</td>
                    <td className="px-4 py-3">
                      <StatusDot status={DOT[d.status]} label={d.status} />
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={d.dnsMode === "auto" ? "indigo" : "muted"}
                      >
                        {d.dnsMode === "auto" ? "Cloudflare" : "manual"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-white/65">{d.region}</td>
                    <td className="px-4 py-3 text-white/65">
                      {formatWhen(d.lastCheckedAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link href={`/app/domains/${d.id}`}>Details</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
