import Link from "next/link";
import { redirect } from "next/navigation";
import { env } from "@/env";
import { getSession } from "@/lib/session";
import { safeNext } from "@/lib/safe-next";
import { AuthForm } from "@/components/auth/AuthForm";

export const metadata = { title: "Sign up" };

export default async function SignupPage(props: PageProps<"/signup">) {
  const sp = await props.searchParams;
  const next = safeNext(sp.next);
  if (await getSession()) redirect(next);
  return (
    <>
      <AuthForm mode="signup" providers={env.providers} next={next} />
      <p className="mt-6 text-sm text-white/60">
        Already have an account?{" "}
        <Link
          className="text-indigo-300"
          href={`/login?next=${encodeURIComponent(next)}`}
        >
          Sign in
        </Link>
      </p>
    </>
  );
}
