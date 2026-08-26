import { redirect } from "next/navigation";

/**
 * Instance administration moved out of the team dashboard to `/admin`.
 *
 * The redirect is unauthenticated on purpose — it does no gating of its own,
 * because `/admin` does, and duplicating the check here would mean two places
 * to get it wrong. Anyone who is not an instance admin lands on `/app`
 * from there, which is exactly where they were.
 */
export default function AdminMoved() {
  redirect("/admin");
}
