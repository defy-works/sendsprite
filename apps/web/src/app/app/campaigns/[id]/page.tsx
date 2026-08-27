import { notFound } from "next/navigation";
import { can, type AudiencePreview } from "@sendsprite/shared";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { audiencePreview } from "@/services/campaigns/audience";
import { getCampaignDetail } from "@/services/campaigns/crud";
import { campaignCounts } from "@/services/campaigns/stats";
import { listBooks } from "@/services/contacts";
import { listDomains } from "@/services/domains";
import { usageSnapshot } from "@/services/send-limits";
import { getTeamAws } from "@/services/team-aws";
import { editorNodesOf } from "@/lib/editor/tree";
import { STATUS_PLAN, capPreflight } from "../send";
import { AudienceCard } from "./AudienceCard";
import { CampaignEditor } from "./CampaignEditor";
import { SendCard } from "./SendCard";
import { StatsPanel } from "./StatsPanel";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireTeam();
  const c = await getCampaignDetail(ctx.team.id, id);
  return { title: c ? `Campaign ${c.name}` : "Campaign" };
}

/** An audience of nobody: what a campaign whose book is gone can be counted at. */
const NO_AUDIENCE: AudiencePreview = {
  contacts: 0,
  subscribed: 0,
  suppressed: 0,
  eligible: 0,
};

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireTeam();
  // Reading is not gated, the way a template is not: the whole team can see a
  // campaign. Only the mutations are gated, and they are gated in the service.
  const c = await getCampaignDetail(ctx.team.id, id);
  if (!c) notFound();
  const canManage = can(ctx.role, "campaigns.manage");
  const aws = await getTeamAws(ctx.team.id);
  const bookExists = c.book !== null;
  const [books, domains, audience, counts, usage] = await Promise.all([
    listBooks(ctx.team.id),
    listDomains(ctx.team.id),
    // Skipped when the book is gone: `book_id` carries no foreign key, so the
    // id can point at nothing, and counting contacts in a book that does not
    // exist would print a confident zero instead of "the book is gone".
    bookExists
      ? audiencePreview(ctx.team.id, c.bookId)
      : Promise.resolve(NO_AUDIENCE),
    // Derived on every render rather than read from `campaigns.counts`: the
    // cache is refreshed by the sweep, and a page that showed the cache would
    // lag a sending campaign by up to a tick. This reads; it does not write.
    campaignCounts(ctx.team.id, c.id),
    usageSnapshot(ctx.team.id),
  ]);

  const plan = STATUS_PLAN[c.status];
  const stats = (
    <StatsPanel campaignId={c.id} status={c.status} counts={counts} />
  );

  return (
    <div className="flex flex-col gap-6">
      {/* Once a campaign has left, what happened to it is the reason somebody
          opened this page; the body they can no longer edit is not. */}
      {plan.statsFirst && stats}

      <CampaignEditor
        mode="edit"
        campaignId={c.id}
        status={c.status}
        canManage={canManage}
        userEmail={ctx.session.user.email}
        sesSandbox={aws?.sesAccountStatus !== "production"}
        books={books.map((b) => ({
          id: b.id,
          name: b.name,
          contactCount: b.contactCount,
        }))}
        // Only verified domains are offered: `checkRefs` refuses anything else,
        // and a campaign sent from an unverified domain fails for every
        // recipient. A campaign still pointing at one shows as "deleted or
        // unverified" in the editor rather than vanishing from the list.
        domains={domains
          .filter((d) => d.status === "verified")
          .map((d) => ({ id: d.id, name: d.name }))}
        campaign={{
          name: c.name,
          bookId: c.bookId,
          domainId: c.domainId,
          from: c.from,
          replyTo: c.replyTo ?? "",
          subject: c.subject,
          nodes: editorNodesOf(c.blocks),
          theme: c.theme ?? {},
          mergeDefaults: c.mergeDefaults ?? {},
        }}
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <AudienceCard
          audience={bookExists ? audience : null}
          bookId={c.bookId}
          bookName={c.book?.name ?? null}
        />
        <SendCard
          campaignId={c.id}
          name={c.name}
          status={c.status}
          canManage={canManage}
          bookName={c.book?.name ?? null}
          bookExists={bookExists}
          audience={audience}
          counts={counts}
          // Formatted here, not in the client component: `formatWhen` pins the
          // locale and the zone precisely so a server render and a hydration
          // cannot disagree about what a date looks like.
          scheduledLabel={c.scheduledAt ? formatWhen(c.scheduledAt) : null}
          // The pre-flight cap comparison, made against this campaign's own
          // eligible count before anything leaves. The fan-out checks the same
          // caps per chunk and pauses; the point of doing it here is that
          // learning about a cap at recipient 12 000 of 50 000 is too late.
          cap={capPreflight(audience.eligible, usage)}
        />
      </div>

      {!plan.statsFirst && counts.recipients > 0 && stats}
    </div>
  );
}
