"use client";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";

/** better-auth's own floor; stating it here keeps the client-side check honest. */
const MIN_LENGTH = 8;

export function PasswordForm() {
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Checked here so the mismatch is caught before a round trip, and again by
  // the server for length — the server is the one that decides.
  const mismatch = again !== "" && next !== again;
  const tooShort = next !== "" && next.length < MIN_LENGTH;
  const ready = current !== "" && next.length >= MIN_LENGTH && next === again;

  const submit = () =>
    start(async () => {
      setError(null);
      try {
        const res = await authClient.changePassword({
          currentPassword: current,
          newPassword: next,
          revokeOtherSessions: revokeOthers,
        });
        if (res.error)
          return setError(
            res.error.message ?? "Could not change your password.",
          );
        setCurrent("");
        setNext("");
        setAgain("");
        toast({
          tone: "success",
          title: "Password changed",
          body: revokeOthers
            ? "Every other session has been signed out."
            : "Your other sessions are still signed in.",
        });
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) submit();
      }}
    >
      <Field id="pw-current" label="Current password">
        <Input
          id="pw-current"
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </Field>
      <Field
        id="pw-new"
        label="New password"
        hint={`At least ${MIN_LENGTH} characters.`}
        error={tooShort ? `At least ${MIN_LENGTH} characters.` : undefined}
      >
        <Input
          id="pw-new"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      <Field
        id="pw-again"
        label="New password again"
        error={mismatch ? "These two do not match." : undefined}
      >
        <Input
          id="pw-again"
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
      </Field>
      <Switch
        checked={revokeOthers}
        onChange={setRevokeOthers}
        label="Sign out everywhere else"
        hint="On by default: the usual reason to change a password is that somebody else may know the old one."
      />
      <div>
        <Button type="submit" loading={pending} disabled={!ready}>
          Change password
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </form>
  );
}
