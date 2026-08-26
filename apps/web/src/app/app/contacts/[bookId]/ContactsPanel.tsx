"use client";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, useTransition } from "react";
import { can, type TeamRole } from "@sendsprite/shared";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import {
  addContact,
  importCsv,
  removeContact,
  setSubscribed,
  type Result,
} from "../actions";
import { useConfirm } from "@/components/ui/confirm";
import { resubscribeConfirmation } from "../resubscribe";

/** Dates are pre-formatted on the server so SSR and hydration agree. */
export type ContactRow = {
  id: string;
  email: string;
  name: string;
  subscribed: boolean;
  reason: string | null;
  /** `formatWhen(unsubscribedAt)`; "never" when they never left. */
  unsubscribed: string;
  created: string;
};

/**
 * The largest file this will read, in **bytes**.
 *
 * Three caps have to agree for the friendly message below to be the one a
 * customer actually sees. `parseCsv` refuses more than 2 MB of UTF-8;
 * `ImportContactsInput` refuses more than 2 MB of characters; and the CSV
 * travels to `importCsv` as a server-action argument, which Next bounds at
 * `serverActions.bodySizeLimit` — 1 MB by default, which would have turned a
 * 1.5 MB list into an opaque 413 with none of this text attached.
 * `next.config.ts` raises that to 3 MB precisely so this cap is the one that
 * fires. Bytes rather than characters because bytes is what every other cap
 * on the path measures, and what the customer's file manager shows them.
 */
const MAX_CSV_BYTES = 2 * 1024 * 1024;
const TOO_LARGE =
  "This CSV is larger than 2 MB. Split it into smaller files, each under 2 MB, and import them one after another — every part lands in the same book.";

export function ContactsPanel({
  bookId,
  bookName,
  contacts,
  query,
  truncated,
  loadError,
  role,
}: {
  bookId: string;
  bookName: string;
  contacts: ContactRow[];
  query: string;
  truncated: boolean;
  /** Set when the list could not be read at all; never rendered as "empty". */
  loadError: string | null;
  role: TeamRole;
}) {
  const router = useRouter();
  // Every mutation on this page needs `contacts.manage` and nothing more —
  // the one contact action that needs `settings.manage` is deleting the
  // *book*, which lives on /app/contacts.
  const canManage = can(role, "contacts.manage");
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => addContact(bookId, fd),
    null,
  );
  const confirm = useConfirm();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const act = (fn: () => Promise<Result>) =>
    start(async () => {
      setError(null);
      try {
        const res = await fn();
        if (!res.ok) setError(res.error);
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });

  /**
   * Leaving is one click; coming back is confirmed. The dialog names the date
   * and the recorded reason, because those are the two facts that separate
   * "they asked to come back" from "somebody clicked the wrong row".
   */
  const toggle = async (c: ContactRow) => {
    if (!c.subscribed) {
      const copy = resubscribeConfirmation({
        email: c.email,
        reason: c.reason,
        unsubscribedWhen: c.unsubscribed,
      });
      const ok = await confirm({
        title: copy.title,
        body: copy.body,
        confirmLabel: "Resubscribe",
      });
      if (!ok) return;
    }
    act(() => setSubscribed(bookId, c.id, !c.subscribed));
  };

  const onFile = async (file: File) => {
    setError(null);
    setImported(null);
    // Checked before the read, so a 40 MB file is refused rather than pulled
    // into memory to be measured.
    if (file.size > MAX_CSV_BYTES) return setError(TOO_LARGE);
    const text = await file.text();
    start(async () => {
      try {
        const res = await importCsv(bookId, text);
        if (!res.ok) return setError(res.error);
        const r = res.data;
        setImported(
          `${r.imported} added, ${r.updated} updated, ${r.skipped} skipped, ${r.duplicates} duplicate rows collapsed.` +
            (r.errors.length
              ? ` First problem: line ${r.errors[0]!.line} — ${r.errors[0]!.reason}`
              : ""),
        );
        if (fileRef.current) fileRef.current.value = "";
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="num-stamp">{bookName}</p>
        <a
          href={`/app/contacts/${bookId}/export`}
          className="text-sm text-white/60 underline decoration-white/30 underline-offset-2 hover:text-white"
        >
          Export CSV
        </a>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const q = new FormData(e.currentTarget).get("q");
          router.push(
            `/app/contacts/${bookId}${q ? `?q=${encodeURIComponent(String(q))}` : ""}`,
          );
        }}
      >
        <div className="min-w-64 flex-1">
          <Label htmlFor="contact-q">Search</Label>
          <Input
            id="contact-q"
            name="q"
            defaultValue={query}
            placeholder="address or name"
          />
        </div>
        <Button type="submit" variant="subtle">
          Search
        </Button>
      </form>

      {canManage && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Add a contact</CardTitle>
            </CardHeader>
            <CardBody>
              <form action={action} className="flex flex-wrap items-end gap-3">
                <div className="min-w-48 flex-1">
                  <Label htmlFor="c-email">Email</Label>
                  <Input id="c-email" name="email" type="email" required />
                </div>
                <div className="min-w-32 flex-1">
                  <Label htmlFor="c-first">First name</Label>
                  <Input id="c-first" name="firstName" />
                </div>
                <div className="min-w-32 flex-1">
                  <Label htmlFor="c-last">Last name</Label>
                  <Input id="c-last" name="lastName" />
                </div>
                <Button type="submit" disabled={pending}>
                  {pending ? "Adding…" : "Add"}
                </Button>
              </form>
              {state && !state.ok && <Alert>{state.error}</Alert>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Import CSV</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                aria-label="CSV file"
                className="text-sm text-white/70"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
              <p className="text-xs text-white/50">
                Needs an <code>email</code> column; <code>first_name</code> and{" "}
                <code>last_name</code> are recognised and every other column
                becomes a property. Up to 2 MB and 10 000 rows per file. A row
                marked unsubscribed stays unsubscribed — no file can put
                somebody back on the list.
              </p>
              {imported && <p className="text-sm text-white/70">{imported}</p>}
            </CardBody>
          </Card>
        </div>
      )}

      {loadError ? (
        <Alert>
          {`These contacts could not be loaded, so this is not an empty book: ${loadError} Reload the page to try again.`}
        </Alert>
      ) : contacts.length === 0 ? (
        <EmptyState
          title={query ? "No matches" : "No contacts yet"}
          body={
            query
              ? `Nothing in ${bookName} matches "${query}". Search matches the start of an address, or any part of a name. Clear the box to see everyone.`
              : canManage
                ? "Add one above, or import a CSV. A contact's subscription status is consent for campaigns from this book; blocking an address everywhere is a suppression instead."
                : "Nobody has been added to this book yet. Ask an admin to add a contact or import a CSV."
          }
        />
      ) : (
        <div className="glass overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="num-stamp text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Added</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-t border-white/8">
                  <td className="px-4 py-3 font-medium">{c.email}</td>
                  <td className="px-4 py-3 text-white/65">{c.name || "—"}</td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={c.subscribed ? "success" : "warning"}
                      title={
                        c.subscribed
                          ? undefined
                          : `Unsubscribed ${c.unsubscribed}`
                      }
                    >
                      {c.subscribed
                        ? "subscribed"
                        : (c.reason ?? "unsubscribed")}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-white/65">{c.created}</td>
                  <td className="px-4 py-3 text-right">
                    {canManage && (
                      <>
                        <Button
                          size="sm"
                          variant="subtle"
                          disabled={busy}
                          onClick={() => toggle(c)}
                        >
                          {c.subscribed ? "Unsubscribe" : "Resubscribe"}
                        </Button>
                        <Button
                          size="sm"
                          variant="subtle"
                          disabled={busy}
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Delete ${c.email}?`,
                              body: "They are removed from this book. Their suppression status, if any, is separate and is left alone.",
                              confirmLabel: "Delete contact",
                              tone: "danger",
                            });
                            if (ok) act(() => removeContact(bookId, c.id));
                          }}
                        >
                          Delete
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && (
        <p className="text-sm text-white/60">
          Showing the first 100. Use search to narrow, or export the whole book.
        </p>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
