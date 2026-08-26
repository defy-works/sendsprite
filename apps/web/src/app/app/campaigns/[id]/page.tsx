import { notFound } from "next/navigation";
import { can } from "@sendsprite/shared";
import { requireTeam } from "@/lib/session";
import { getCampaignDetail } from "@/services/campaigns/crud";
import { listBooks } from "@/services/contacts";
import { listDomains } from "@/services/domains";
import { editorBlocksOf } from "../preview";
import { CampaignEditor } from "./CampaignEditor";

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
  const [books, domains] = await Promise.all([
    listBooks(ctx.team.id),
    listDomains(ctx.team.id),
  ]);

  return (
    <CampaignEditor
      mode="edit"
      campaignId={c.id}
      status={c.status}
      canManage={can(ctx.role, "campaigns.manage")}
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
        blocks: editorBlocksOf(c.blocks),
      }}
    />
  );
}
