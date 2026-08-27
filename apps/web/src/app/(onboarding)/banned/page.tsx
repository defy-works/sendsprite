import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { user } from "@/db/schema";
import { getSession } from "@/lib/session";
import { SignOutLink } from "@/components/app/SignOutLink";

export const metadata = { title: "Account suspended" };

/**
 * Where a banned account lands.
 *
 * Outside `requireSession`, which is what sends people here — a page that
 * called it would bounce off itself. It reads the session directly and shows
 * the door: there is nothing else this person can do here, and pretending
 * otherwise wastes their time.
 *
 * The reason is shown when there is one. An operator who bans without a reason
 * gets a page that says so plainly rather than one that invents an
 * explanation.
 */
export default async function BannedPage() {
  const s = await getSession();
  if (!s) redirect("/login");
  const [row] = await db()
    .select({ at: user.bannedAt, reason: user.bannedReason })
    .from(user)
    .where(eq(user.id, s.user.id))
    .limit(1);
  if (!row?.at) redirect("/app");

  return (
    <main className="grid-hairlines flex min-h-dvh items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-4">
        <div className="glass-strong p-8">
          <p className="num-stamp text-danger">Account suspended</p>
          <h1 className="mt-4 text-lg font-medium">
            This account cannot use Sendsprite.
          </h1>
          <p className="mt-2 text-sm text-white/65">
            {row.reason
              ? row.reason
              : "An administrator of this instance suspended it. No reason was given."}
          </p>
          <p className="mt-3 text-sm text-white/50">
            Anything your teams send through the API is unaffected by this.
          </p>
        </div>
        <p className="text-center text-sm text-white/45">
          <SignOutLink />
        </p>
      </div>
    </main>
  );
}
