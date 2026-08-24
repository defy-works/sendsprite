import Link from "next/link";
import { redirect } from "next/navigation";
import { env } from "@/env";
import { getSession } from "@/lib/session";
import { AuthForm } from "@/components/auth/AuthForm";

export const metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  if (await getSession()) redirect("/app");
  const sp = await props.searchParams;
  const next =
    typeof sp.next === "string" && sp.next.startsWith("/") ? sp.next : "/app";
  return (
    <>
      <AuthForm mode="login" providers={env.providers} next={next} />
      <p className="mt-6 text-sm text-white/60">
        No account?{" "}
        <Link
          className="text-indigo-300"
          href={`/signup?next=${encodeURIComponent(next)}`}
        >
          Sign up
        </Link>
      </p>
    </>
  );
}
