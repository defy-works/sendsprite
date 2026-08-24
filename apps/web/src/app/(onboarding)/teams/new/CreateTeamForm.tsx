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

export function CreateTeamForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const res = await authClient.organization.create({
      name,
      slug: slugify(name) || `team-${Date.now()}`,
    });
    if (res.error)
      return setError(res.error.message ?? "Could not create team");
    await authClient.organization.setActive({ organizationId: res.data.id });
    router.push("/app");
    router.refresh();
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
      <Button type="submit">Create team</Button>
    </form>
  );
}
