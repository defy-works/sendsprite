import { redirect } from "next/navigation";
import Link from "next/link";
import { env } from "@/env";

export default function HomePage() {
  if (!env.LANDING_ENABLED) redirect("/app");
  return (
    <main className="grid-hairlines flex min-h-dvh flex-col items-center justify-center gap-6 p-8">
      <p className="num-stamp">Sendsprite</p>
      <h1 className="metric-xl text-center">
        Self-hosted email API
        <br />
        on Amazon SES.
      </h1>
      <Link
        href="/app"
        className="rounded-md bg-indigo-500 px-5 py-2.5 text-sm font-medium hover:bg-indigo-400"
      >
        Open dashboard
      </Link>
    </main>
  );
}
