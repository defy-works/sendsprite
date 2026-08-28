"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Divider } from "@/components/ui/Divider";
import { GitHubIcon, GoogleIcon } from "./BrandIcons";

export interface AuthFormProps {
  mode: "login" | "signup";
  providers: { google: boolean; github: boolean; emailPassword: boolean };
  /** Where to go after success. */
  next?: string;
  /** Message to show on first render, e.g. from an OAuth `?error=`. */
  initialError?: string | null;
}

export function AuthForm({
  mode,
  providers,
  next = "/app",
  initialError = null,
}: AuthFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email"));
    const password = String(fd.get("password"));
    try {
      const res =
        mode === "signup"
          ? await authClient.signUp.email({
              email,
              password,
              name: String(fd.get("name") || email.split("@")[0]),
            })
          : await authClient.signIn.email({ email, password });
      if (res.error) {
        setError(res.error.message ?? "Something went wrong");
        return;
      }
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function social(provider: "google" | "github") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.signIn.social({
        provider,
        callbackURL: next,
        // Without this, provider errors land on better-auth's bare
        // /api/auth/error page whose only link is the landing page.
        errorCallbackURL: `${window.location.pathname}?next=${encodeURIComponent(next)}`,
      });
      if (res.error) setError(res.error.message ?? "Sign-in failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-medium">
        {mode === "login" ? "Sign in" : "Create your account"}
      </h1>
      {providers.emailPassword && (
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          {mode === "signup" && (
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" autoComplete="name" />
            </div>
          )}
          <div>
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
            />
          </div>
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete={
                mode === "signup" ? "new-password" : "current-password"
              }
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "…" : mode === "login" ? "Sign in" : "Sign up"}
          </Button>
        </form>
      )}
      {providers.emailPassword && (providers.google || providers.github) && (
        <Divider />
      )}
      {(providers.google || providers.github) && (
        <div className="flex flex-col gap-2">
          {providers.google && (
            <Button
              variant="secondary"
              disabled={busy}
              icon={<GoogleIcon />}
              onClick={() => social("google")}
            >
              Continue with Google
            </Button>
          )}
          {providers.github && (
            <Button
              variant="secondary"
              disabled={busy}
              icon={<GitHubIcon />}
              onClick={() => social("github")}
            >
              Continue with GitHub
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      {!providers.emailPassword && !providers.google && !providers.github && (
        <p className="text-sm text-amber-300">
          No auth provider is configured. Set EMAIL_PASSWORD_ENABLED=true or a
          Google/GitHub client id + secret.
        </p>
      )}
    </div>
  );
}
