import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { member } from "@/db/schema";
import { requireSession } from "@/lib/session";
import { SignOutLink } from "@/components/app/SignOutLink";
import { CreateTeamForm } from "./CreateTeamForm";

export const metadata = { title: "Create team" };

/**
 * There is always a way out of this screen.
 *
 * It had none: the form was the whole page, and anyone who opened it from the
 * team switcher to look at it was stuck with the browser's back button or a
 * hand-typed URL. Which exit is offered depends on whether there is anywhere
 * to go — somebody who already belongs to a team can just leave, and somebody
 * signing up for the first time cannot, so they are offered the only other
 * door there is.
 */
export default async function NewTeamPage() {
  const session = await requireSession();
  const memberships = await db().$count(
    member,
    eq(member.userId, session.user.id),
  );

  return (
    <main className="grid-hairlines flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="glass-strong p-8">
          <p className="num-stamp">New team</p>
          <CreateTeamForm />
        </div>
        <p className="text-center text-sm text-white/45">
          {Number(memberships) > 0 ? (
            <Link
              href="/app"
              className="text-white/55 no-underline hover:text-white"
            >
              Back to the dashboard
            </Link>
          ) : (
            <>
              Not ready yet? <SignOutLink />
            </>
          )}
        </p>
      </div>
    </main>
  );
}
