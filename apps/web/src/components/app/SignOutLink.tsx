"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { useToast } from "@/components/ui/toast";

/**
 * Sign out, as a sentence rather than a button.
 *
 * For the screens that are otherwise a dead end — creating a first team, or
 * waiting for an invitation — where the only honest alternative to going
 * forward is leaving.
 */
export function SignOutLink({ label = "Sign out" }: { label?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await authClient.signOut();
          router.push("/login");
          router.refresh();
        } catch {
          setBusy(false);
          toast({
            tone: "error",
            title: "Could not sign out",
            body: "The server did not answer. Check your connection and try again.",
          });
        }
      }}
      className="text-white/55 underline underline-offset-2 transition-colors hover:text-white disabled:opacity-60"
    >
      {busy ? "Signing out…" : label}
    </button>
  );
}
