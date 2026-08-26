import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@sendsprite/shared";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { requireTeam } from "@/lib/session";
import { listBooks } from "@/services/contacts";
import { listDomains } from "@/services/domains";
import { blockDefaults, editorBlocksOf } from "../preview";
import { CampaignEditor } from "../[id]/CampaignEditor";

export const metadata = { title: "New campaign" };

export default async function NewCampaignPage() {
  const ctx = await requireTeam();
  // A member cannot create one, and an empty form they cannot submit is worse
  // than the list, which explains what a campaign is.
  if (!can(ctx.role, "campaigns.manage")) redirect("/app/campaigns");

  const [books, allDomains] = await Promise.all([
    listBooks(ctx.team.id),
    listDomains(ctx.team.id),
  ]);
  const domains = allDomains.filter((d) => d.status === "verified");

  // Both are required by `CreateCampaignInput` and neither can be created from
  // here, so the honest answer is the missing step rather than a form with two
  // empty selects that refuses every save.
  if (books.length === 0 || domains.length === 0)
    return (
      <EmptyState
        eyebrow="Not ready yet"
        title={
          books.length === 0
            ? "A campaign needs a contact book"
            : "A campaign needs a verified domain"
        }
        body={
          books.length === 0
            ? "A campaign mails everyone in a book who is subscribed and not suppressed. Create a book and add contacts first."
            : "Campaign mail is sent from a verified domain, the same as any other send. Verify one and come back."
        }
        action={
          <Button asChild>
            <Link href={books.length === 0 ? "/app/contacts" : "/app/domains"}>
              {books.length === 0 ? "Contacts" : "Domains"}
            </Link>
          </Button>
        }
      />
    );

  const domain = domains[0];
  const book = books[0];

  return (
    <CampaignEditor
      mode="create"
      canManage
      books={books.map((b) => ({
        id: b.id,
        name: b.name,
        contactCount: b.contactCount,
      }))}
      domains={domains.map((d) => ({ id: d.id, name: d.name }))}
      campaign={{
        name: "",
        bookId: book?.id ?? "",
        domainId: domain?.id ?? "",
        // A guess at an address on the chosen domain, not a rule: `checkRefs`
        // resolves the real one and refuses anything that is not at a verified
        // domain of this team.
        from: domain ? `hello@${domain.name}` : "",
        replyTo: "",
        subject: "",
        // A starter rather than a blank page — the preview is the thing worth
        // seeing first, and it has nothing to show until a block exists.
        blocks: editorBlocksOf([
          blockDefaults("heading"),
          blockDefaults("text"),
        ]),
      }}
    />
  );
}
