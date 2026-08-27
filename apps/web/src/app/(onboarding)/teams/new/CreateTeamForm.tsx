"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

const suffix = () => Math.random().toString(36).slice(2, 6);

// createOrganization throws ORGANIZATION_ALREADY_EXISTS on a slug clash;
// ORGANIZATION_SLUG_ALREADY_TAKEN comes from check-slug/updateOrganization.
const SLUG_TAKEN = new Set([
  "ORGANIZATION_ALREADY_EXISTS",
  "ORGANIZATION_SLUG_ALREADY_TAKEN",
]);

export function CreateTeamForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const slug = slugify(name) || `team-${Date.now()}`;
      let res = await authClient.organization.create({ name, slug });
      // Slug collision with another team: retry once with a random suffix.
      if (SLUG_TAKEN.has(res.error?.code ?? "")) {
        res = await authClient.organization.create({
          name,
          slug: `${slug}-${suffix()}`,
        });
      }
      if (res.error) {
        setError(res.error.message ?? "Could not create team");
        return;
      }
      await authClient.organization.setActive({ organizationId: res.data.id });
      router.push("/app");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3">
      <div>
        <Label htmlFor="name">Team name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={2}
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "…" : "Create team"}
      </Button>
    </form>
  );
}
