import Link from "next/link";
import { can } from "@sendsprite/shared";
import { Button } from "@/components/ui/Button";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { listCampaignsPage } from "@/services/campaigns/crud";
import { listBooks } from "@/services/contacts";
import { CampaignList, type CampaignRow } from "./CampaignList";

export const metadata = { title: "Campaigns" };

const PAGE = 25;
type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const ctx = await requireTeam();
  const sp = await searchParams;
  const canManage = can(ctx.role, "campaigns.manage");
  const [res, books] = await Promise.all([
    listCampaignsPage(ctx.team.id, { limit: PAGE, cursor: one(sp.cursor) }),
    listBooks(ctx.team.id),
  ]);
  // A cursor edited by hand shows page one rather than an error page, the
  // same fallback the mail log uses.
  const first = res.ok
    ? res
    : await listCampaignsPage(ctx.team.id, { limit: PAGE });
  const page = first.ok ? first.data : { data: [], nextCursor: null };

  const rows: CampaignRow[] = page.data.map((c) => ({
    id: c.id,
    name: c.name,
    status: c.status,
    // `null` is rendered as "book deleted", not dropped: `book_id` carries no
    // foreign key, so a campaign genuinely outlives the book it was sent to.
    bookName: c.book?.name ?? null,
    recipients: c.counts.recipients,
    sent: c.sentAt ? formatWhen(c.sentAt) : null,
    scheduled: c.scheduledAt ? formatWhen(c.scheduledAt) : null,
    created: formatWhen(c.createdAt),
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="num-stamp">Campaigns</p>
          <p className="mt-1 max-w-2xl text-sm text-white/60">
            One designed email, sent to everyone in a contact book who is
            subscribed and not suppressed. The body is a list of blocks rather
            than free HTML, so what you see in the preview is what the send
            produces.
          </p>
        </div>
        {canManage && books.length > 0 && (
          <Button asChild>
            <Link href="/app/campaigns/new">New campaign</Link>
          </Button>
        )}
      </div>
      <CampaignList
        campaigns={rows}
        canManage={canManage}
        hasBook={books.length > 0}
      />
      {page.nextCursor && (
        <div>
          <Button asChild variant="secondary" size="sm">
            <Link href={`/app/campaigns?cursor=${page.nextCursor}`}>
              Older campaigns
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
