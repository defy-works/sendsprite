import Link from "next/link";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { listBooks } from "@/services/contacts";
import { BooksPanel, type BookRow } from "./BooksPanel";

export const metadata = { title: "Contacts" };

export default async function ContactsPage() {
  const ctx = await requireTeam();
  const books: BookRow[] = (await listBooks(ctx.team.id)).map((b) => ({
    id: b.id,
    name: b.name,
    contactCount: b.contactCount,
    subscribedCount: b.subscribedCount,
    created: formatWhen(b.createdAt),
  }));
  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="num-stamp">Contacts</p>
        <p className="mt-1 max-w-2xl text-sm text-white/60">
          A book is an audience. Each contact in it carries a subscription
          status, which is consent for campaigns from that book — it is not the{" "}
          <Link
            href="/app/suppressions"
            className="underline decoration-white/30 underline-offset-2 hover:text-white"
          >
            suppression list
          </Link>
          , which blocks every message to an address, password resets and
          receipts included.
        </p>
      </div>
      <BooksPanel books={books} role={ctx.role} />
    </div>
  );
}
