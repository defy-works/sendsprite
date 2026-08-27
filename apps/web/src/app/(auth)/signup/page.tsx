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
      <p className="mt-4 text-xs text-white/45">
        By creating an account you agree to the{" "}
        <Link
          className="text-indigo-300/80 hover:text-indigo-200"
          href="/terms"
        >
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link
          className="text-indigo-300/80 hover:text-indigo-200"
          href="/privacy"
        >
          Privacy Policy
        </Link>
        .
      </p>
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
