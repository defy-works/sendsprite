import { notFound } from "next/navigation";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { getBook, listContactsPage } from "@/services/contacts";
import { ContactsPanel, type ContactRow } from "./ContactsPanel";

export const metadata = { title: "Contact book" };

/** One page of 100; the search box narrows rather than paging deeply. */
const PAGE = 100;
/** `ListContactsQuery.q`'s bound, applied here because this `q` is not parsed. */
const MAX_QUERY_CHARS = 120;

export default async function BookPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { bookId } = await params;
  const { q: rawQ } = await searchParams;
  const q = (rawQ ?? "").trim().slice(0, MAX_QUERY_CHARS);
  const ctx = await requireTeam();
  const book = await getBook(ctx.team.id, bookId);
  if (!book) notFound();
  const page = await listContactsPage(ctx.team.id, bookId, {
    limit: PAGE,
    ...(q ? { q } : {}),
  });
  // A failed query and an empty book must not render the same thing: the
  // empty state says "there is nobody here", which about a list that could
  // not be read is simply false, and it is false in the direction that gets
  // somebody re-importing a file they already imported.
  const rows: ContactRow[] = page.ok
    ? page.data.data.map((c) => ({
        id: c.id,
        email: c.email,
        name: [c.firstName, c.lastName].filter(Boolean).join(" "),
        subscribed: c.subscribed,
        reason: c.unsubscribeReason,
        unsubscribed: formatWhen(c.unsubscribedAt),
        created: formatWhen(c.createdAt),
      }))
    : [];
  return (
    <ContactsPanel
      bookId={bookId}
      bookName={book.name}
      contacts={rows}
      query={q}
      truncated={page.ok && page.data.nextCursor !== null}
      loadError={page.ok ? null : page.error}
      role={ctx.role}
    />
  );
}
