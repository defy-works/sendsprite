import Link from "next/link";
import { redirect } from "next/navigation";
import { env } from "@/env";
import { getSession } from "@/lib/session";
import { safeNext } from "@/lib/safe-next";
import { AuthForm } from "@/components/auth/AuthForm";
import { describeOAuthError } from "@/lib/oauth-error";

export const metadata = { title: "Sign in" };

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = safeNext(sp.next);
  const oauthError = describeOAuthError(
    typeof sp.error === "string" ? sp.error : undefined,
  );
  if (await getSession()) redirect(next);
  return (
    <>
      <AuthForm
        mode="login"
        providers={env.providers}
        next={next}
        initialError={oauthError}
      />
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
