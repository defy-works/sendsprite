import { EMAIL_STATUS, type EmailStatus } from "@sendsprite/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Link } from "@/components/ui/Link";
import { Select } from "@/components/ui/Select";
import { requireTeam } from "@/lib/session";
import { listDomains } from "@/services/domains";
import { listEmails } from "@/services/emails";
import { EmailsTable, toListRow } from "./EmailsTable";
import { LiveRefresh } from "./LiveRefresh";

export const metadata = { title: "Emails" };

const PAGE = 50;
type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const isStatus = (s: string | undefined): s is EmailStatus =>
  (EMAIL_STATUS as readonly string[]).includes(s ?? "");

export default async function EmailsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const ctx = await requireTeam();
  const sp = await searchParams;
  const status = one(sp.status);
  const filters = {
    status: isStatus(status) ? status : undefined,
    to: one(sp.to),
    domainId: one(sp.domainId),
    tag: one(sp.tag),
    // Set by the links on a campaign's results panel. There is no control for
    // it in the form below — a select of every campaign a team has ever sent
    // would be a long list nobody scrolls — so it rides along as a hidden
    // field and is cleared by "Clear" like any other filter.
    campaignId: one(sp.campaignId),
  };
  const [res, domains] = await Promise.all([
    listEmails(ctx.team.id, {
      ...filters,
      limit: PAGE,
      cursor: one(sp.cursor),
    }),
    listDomains(ctx.team.id),
  ]);
  // A malformed cursor in the URL (edited by hand) shows page one.
  const first = res.ok
    ? res
    : await listEmails(ctx.team.id, { ...filters, limit: PAGE });
  const page = first.ok ? first.data : { data: [], nextCursor: null };
  const byId = new Map(domains.map((d) => [d.id, d.name]));
  const rows = page.data.map((e) =>
    toListRow(e, (id) => (id ? (byId.get(id) ?? null) : null)),
  );
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) next.set(k, v);
  if (page.nextCursor) next.set("cursor", page.nextCursor);
  const filtered = Object.values(filters).some(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <LiveRefresh />
      <form
        method="get"
        className="glass flex flex-wrap items-end gap-3 p-4"
        aria-label="Filter emails"
      >
        <label className="flex flex-col gap-1 text-xs text-white/60">
          Status
          <Select name="status" defaultValue={filters.status ?? ""}>
            <option value="">Any</option>
            {EMAIL_STATUS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-white/60">
          To
          <Input
            name="to"
            defaultValue={filters.to ?? ""}
            placeholder="someone@example.com"
            autoComplete="off"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-white/60">
          Domain
          <Select name="domainId" defaultValue={filters.domainId ?? ""}>
            <option value="">Any</option>
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-white/60">
          Tag
          <Input
            name="tag"
            defaultValue={filters.tag ?? ""}
            placeholder="key:value"
            autoComplete="off"
          />
        </label>
        {filters.campaignId && (
          <input type="hidden" name="campaignId" value={filters.campaignId} />
        )}
        <Button type="submit" variant="secondary">
          Filter
        </Button>
        {filtered && (
          <Link href="/app/emails" className="text-sm">
            Clear
          </Link>
        )}
      </form>

      {filters.campaignId && (
        <p className="text-sm text-white/60">
          Showing one campaign&rsquo;s mail.{" "}
          <Link href={`/app/campaigns/${filters.campaignId}`}>
            Back to the campaign
          </Link>
        </p>
      )}

      <EmailsTable
        emails={rows}
        emptyBody={filtered ? "No emails match these filters." : undefined}
      />
      {page.nextCursor && (
        <div>
          <Button asChild variant="secondary">
            <Link
              href={`/app/emails?${next.toString()}`}
              className="no-underline"
            >
              Load more
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
