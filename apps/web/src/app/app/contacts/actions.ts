"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { ImportContactsResult } from "@sendsprite/shared";
import { enqueue } from "@/jobs/enqueue";
import { requestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { requireTeam } from "@/lib/session";
import * as contacts from "@/services/contacts";

export type { Result } from "@/lib/result";

/** Server actions are thin: resolve the actor, delegate, revalidate. */
async function actor() {
  const ctx = await requireTeam();
  return {
    userId: ctx.userId,
    teamId: ctx.team.id,
    teamName: ctx.team.name,
    role: ctx.role,
    meta: requestMeta(await headers()),
  };
}
const deps = { enqueue };

export async function createBook(fd: FormData): Promise<Result> {
  const res = await contacts.createBook(await actor(), {
    name: fd.get("name"),
    defaultFrom: String(fd.get("defaultFrom") ?? "").trim() || undefined,
  });
  if (!res.ok) return res;
  revalidatePath("/app/contacts");
  return { ok: true, data: undefined };
}

/** Needs `settings.manage`, not `contacts.manage`: see `deleteBook` in the service. */
export async function deleteBook(bookId: string): Promise<Result> {
  const res = await contacts.deleteBook(await actor(), bookId);
  if (res.ok) revalidatePath("/app/contacts");
  return res;
}

export async function addContact(
  bookId: string,
  fd: FormData,
): Promise<Result> {
  const res = await contacts.createContact(
    await actor(),
    bookId,
    {
      email: fd.get("email"),
      firstName: String(fd.get("firstName") ?? "").trim() || undefined,
      lastName: String(fd.get("lastName") ?? "").trim() || undefined,
    },
    deps,
  );
  if (!res.ok) return res;
  revalidatePath(`/app/contacts/${bookId}`);
  return { ok: true, data: undefined };
}

/**
 * Flips consent for one contact in one book. Never a suppression: a
 * suppression is team-wide and blocks transactional mail too, and nothing in
 * this file may reach for one. See `services/contacts.ts`.
 *
 * Resubscribing is confirmed in the panel before it gets here
 * (`resubscribe.ts` holds the wording), because the service cannot tell an
 * operator acting on a request from an operator who clicked the wrong row.
 */
export async function setSubscribed(
  bookId: string,
  contactId: string,
  subscribed: boolean,
): Promise<Result> {
  const res = await contacts.updateContact(
    await actor(),
    bookId,
    contactId,
    { subscribed, ...(subscribed ? {} : { unsubscribeReason: "manual" }) },
    deps,
  );
  if (!res.ok) return res;
  revalidatePath(`/app/contacts/${bookId}`);
  return { ok: true, data: undefined };
}

export async function removeContact(
  bookId: string,
  contactId: string,
): Promise<Result> {
  const res = await contacts.deleteContact(await actor(), bookId, contactId);
  if (res.ok) revalidatePath(`/app/contacts/${bookId}`);
  return res;
}

/**
 * The client reads the file and sends its text; the service re-checks the cap.
 *
 * The whole CSV travels as one server-action argument, so it is bounded twice
 * on the way in: the panel refuses a file over 2 MB before it is read, and
 * `next.config.ts` raises `serverActions.bodySizeLimit` to 3 MB so that a file
 * the panel accepts cannot be refused by the framework with a 413 the panel
 * has no way to explain. Those two numbers belong together — see the comment
 * on `bodySizeLimit`.
 */
export async function importCsv(
  bookId: string,
  csv: string,
): Promise<Result<ImportContactsResult>> {
  const res = await contacts.importContacts(
    await actor(),
    bookId,
    { csv },
    deps,
  );
  if (res.ok) revalidatePath(`/app/contacts/${bookId}`);
  return res;
}
