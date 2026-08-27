"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/toast";
import { authClient } from "@/lib/auth-client";

const MAX_NAME = 120;

export function ProfileForm({
  name: initial,
  email,
  createdAt,
}: {
  name: string;
  email: string;
  createdAt: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const dirty = name.trim() !== initial.trim();

  const save = () =>
    start(async () => {
      setError(null);
      try {
        const res = await authClient.updateUser({ name: name.trim() });
        if (res.error)
          return setError(res.error.message ?? "Could not save your name.");
        toast({ tone: "success", title: "Profile updated" });
        // The name is on `session.user`, which the app shell renders; refresh
        // so the header initials change with it rather than on next login.
        router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });

  return (
    <div className="flex flex-col gap-4">
      <Field
        id="account-name"
        label="Display name"
        hint="Shown to the rest of your team on the members list."
      >
        <Input
          id="account-name"
          value={name}
          maxLength={MAX_NAME}
          autoComplete="name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) save();
          }}
        />
      </Field>
      <Field
        id="account-email"
        label="Email"
        hint={
          <>
            Also your sign-in. It is the identity every invitation and audit row
            is written against, so changing it is not something this page does —
            create the new account and invite it to your teams. Member since{" "}
            {createdAt}.
          </>
        }
      >
        {/* Read-only rather than absent: people look here to check *which*
            account they are signed in as, which is exactly the question a
            missing field cannot answer. */}
        <Input id="account-email" value={email} readOnly disabled />
      </Field>
      <div>
        <Button loading={pending} disabled={!dirty} onClick={save}>
          Save
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
