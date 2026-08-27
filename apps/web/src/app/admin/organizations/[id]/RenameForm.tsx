"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { useToast } from "@/components/ui/toast";
import { renameOrg } from "../../actions-org";

/**
 * Renames a team as the operator.
 *
 * The team's own owner can already rename it from their settings; this exists
 * for the cases where they cannot or will not — freeing a slug somebody
 * squatted, fixing a name that breaches the terms, or tidying a test team
 * whose owner has gone. The slug is editable for the same reason: it is what
 * the team is addressed by, and renaming without it leaves the old name in
 * every URL.
 */
export function RenameForm({
  teamId,
  name: initialName,
  slug: initialSlug,
}: {
  teamId: string;
  name: string;
  slug: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(initialName);
  const [slug, setSlug] = useState(initialSlug);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dirty = name !== initialName || slug !== initialSlug;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const res = await renameOrg(teamId, name, slug);
          if (!res.ok) return setError(res.error);
          toast({ tone: "success", title: "Team renamed", body: name });
          router.refresh();
        });
      }}
    >
      <Field id="org-name" label="Name">
        <Input
          id="org-name"
          value={name}
          maxLength={120}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field
        id="org-slug"
        label="Slug"
        hint="Lower-case letters, digits and dashes. Unique across the instance."
      >
        <Input
          id="org-slug"
          value={slug}
          maxLength={48}
          required
          onChange={(e) => setSlug(e.target.value)}
        />
      </Field>
      <div>
        <Button type="submit" loading={pending} disabled={!dirty}>
          Save
        </Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </form>
  );
}
