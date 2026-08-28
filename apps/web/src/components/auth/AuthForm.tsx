"use client";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
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

type Method = "google" | "github" | "email";

/**
 * Remembers which method the browser last signed in with so the matching
 * button can carry a "Last used" hint. Written at click time for the social
 * providers — the OAuth flow leaves the page, so there is no client-side
 * success moment to hook.
 */
const LAST_USED_KEY = "sendsprite:last-login";

function readLastUsed(): Method | null {
  try {
    const v = localStorage.getItem(LAST_USED_KEY);
    return v === "google" || v === "github" || v === "email" ? v : null;
  } catch {
    return null;
  }
}

function writeLastUsed(method: Method) {
  try {
    localStorage.setItem(LAST_USED_KEY, method);
  } catch {
    // Private mode / storage disabled: the hint is a nicety, not a feature.
  }
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
  // Email is a two-step flow: the password field only appears after
  // "Continue with email", so the first screen is one field per method.
  const [step, setStep] = useState<"email" | "password">("email");
  // Read after mount: localStorage is not available during SSR and the
  // server-rendered markup must match the first client render.
  const [lastUsed, setLastUsed] = useState<Method | null>(null);
  useEffect(() => setLastUsed(readLastUsed()), []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step === "email") {
      // Native validation has already run for the visible fields.
      setError(null);
      setStep("password");
      return;
    }
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
      writeLastUsed("email");
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
    writeLastUsed(provider);
    try {
      const res = await authClient.signIn.social({
        provider,
        callbackURL: next,
      });
      if (res.error) setError(res.error.message ?? "Sign-in failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const hasSocial = providers.google || providers.github;

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
              placeholder="Your email address"
            />
          </div>
          {step === "password" && (
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                minLength={8}
                autoFocus
                autoComplete={
                  mode === "signup" ? "new-password" : "current-password"
                }
              />
            </div>
          )}
          {step === "email" ? (
            <LastUsedAnchor show={lastUsed === "email"}>
              <Button
                type="submit"
                variant="secondary"
                className="w-full"
                disabled={busy}
              >
                Continue with email
              </Button>
            </LastUsedAnchor>
          ) : (
            <Button type="submit" loading={busy}>
              {mode === "login" ? "Sign in" : "Sign up"}
            </Button>
          )}
        </form>
      )}
      {providers.emailPassword && hasSocial && <Divider label="or" />}
      {hasSocial && (
        <div className="flex flex-col gap-4">
          {providers.google && (
            <LastUsedAnchor show={lastUsed === "google"}>
              <Button
                variant="secondary"
                className="w-full"
                disabled={busy}
                icon={<GoogleIcon />}
                onClick={() => social("google")}
              >
                Continue with Google
              </Button>
            </LastUsedAnchor>
          )}
          {providers.github && (
            <LastUsedAnchor show={lastUsed === "github"}>
              <Button
                variant="secondary"
                className="w-full"
                disabled={busy}
                icon={<GitHubIcon />}
                onClick={() => social("github")}
              >
                Continue with GitHub
              </Button>
            </LastUsedAnchor>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      {!providers.emailPassword && !hasSocial && (
        <p className="text-sm text-amber-300">
          No auth provider is configured. Set EMAIL_PASSWORD_ENABLED=true or a
          Google/GitHub client id + secret.
        </p>
      )}
    </div>
  );
}

/**
 * Wraps a full-width button and, when `show`, hangs a "Last used" pill off
 * its top-right corner. Solid fill on purpose: the card behind is
 * translucent glass, so nothing colour-matched could mask the border.
 */
function LastUsedAnchor({
  show,
  children,
}: {
  show: boolean;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      {children}
      {show && (
        <span
          aria-hidden
          className="absolute -top-2.5 right-0 rounded-md border border-indigo-400/70 bg-[#101014] px-2 py-0.5 text-xs font-medium text-indigo-100 shadow-[0_2px_8px_rgba(0,0,0,0.5)]"
        >
          Last used
        </span>
      )}
    </div>
  );
}
