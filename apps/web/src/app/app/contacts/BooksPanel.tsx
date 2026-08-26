"use client";
import NextLink from "next/link";
import { useActionState, useState, useTransition } from "react";
import { can, type TeamRole } from "@sendsprite/shared";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { useConfirm } from "@/components/ui/confirm";
import { createBook, deleteBook, type Result } from "./actions";

/** Dates are pre-formatted on the server so SSR and hydration agree. */
export type BookRow = {
  id: string;
  name: string;
  contactCount: number;
  subscribedCount: number;
  created: string;
};

/**
 * The two gates here are the two the service enforces, and they are not the
 * same one: `createBook` needs `contacts.manage` (every role has it), while
 * `deleteBook` needs `settings.manage` (owners and admins), because it
 * cascades a whole audience away with no history to restore from. A member
 * therefore sees the create form and no Delete button — showing one that the
 * service would refuse is the bug this mirrors away.
 */
export function BooksPanel({
  books,
  role,
}: {
  books: BookRow[];
  role: TeamRole;
}) {
  const canManage = can(role, "contacts.manage");
  const canDelete = can(role, "settings.manage");
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => createBook(fd),
    null,
  );
  const confirm = useConfirm();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const remove = async (b: BookRow) => {
    const ok = await confirm({
      title: `Delete "${b.name}"?`,
      body: `Its ${b.contactCount.toLocaleString("en-US")} contacts go with it, and there is no history to restore them from.`,
      confirmLabel: "Delete book",
      tone: "danger",
      typeToConfirm: b.name,
    });
    if (!ok) return;
    start(async () => {
      setError(null);
      try {
        const res: Result = await deleteBook(b.id);
        if (!res.ok) setError(res.error);
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>New contact book</CardTitle>
          </CardHeader>
          <CardBody>
            <form action={action} className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <Label htmlFor="book-name">Name</Label>
                <Input
                  id="book-name"
                  name="name"
                  placeholder="Newsletter"
                  required
                />
              </div>
              <div className="min-w-48 flex-1">
                <Label htmlFor="book-from">Default from (optional)</Label>
                <Input
                  id="book-from"
                  name="defaultFrom"
                  placeholder="Acme <hello@mail.acme.com>"
                />
              </div>
              <Button type="submit" disabled={pending}>
                {pending ? "Creating…" : "Create"}
              </Button>
            </form>
            {state && !state.ok && <Alert>{state.error}</Alert>}
          </CardBody>
        </Card>
      )}

      {books.length === 0 ? (
        <EmptyState
          title="No contact books"
          body={
            canManage
              ? "A book is an audience. Contacts in it carry a subscription status — that is consent for campaigns, and it is separate from the suppression list, which blocks all mail to an address. Name your first book above."
              : "A book is an audience. Contacts in it carry a subscription status — that is consent for campaigns, and it is separate from the suppression list, which blocks all mail to an address. Ask an admin to add one."
          }
        />
      ) : (
        <div className="glass overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="num-stamp text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Book</th>
                <th className="px-4 py-3 font-medium">Contacts</th>
                <th className="px-4 py-3 font-medium">Subscribed</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {books.map((b) => (
                <tr key={b.id} className="border-t border-white/8">
                  <td className="px-4 py-3 font-medium">
                    <NextLink
                      href={`/app/contacts/${b.id}`}
                      className="underline decoration-white/30 underline-offset-2 hover:text-white"
                    >
                      {b.name}
                    </NextLink>
                  </td>
                  <td className="px-4 py-3 text-white/65">{b.contactCount}</td>
                  <td className="px-4 py-3 text-white/65">
                    {b.subscribedCount}
                  </td>
                  <td className="px-4 py-3 text-white/65">{b.created}</td>
                  <td className="px-4 py-3 text-right">
                    {canDelete && (
                      <Button
                        size="sm"
                        variant="dangerSubtle"
                        disabled={busy}
                        onClick={() => remove(b)}
                      >
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
