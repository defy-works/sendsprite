"use client";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export function TeamSwitcher({ activeId }: { activeId: string }) {
  const router = useRouter();
  const { data: orgs } = authClient.useListOrganizations();
  async function change(id: string) {
    if (id === "__new") return router.push("/teams/new");
    await authClient.organization.setActive({ organizationId: id });
    router.refresh();
  }
  return (
    <select
      aria-label="Team"
      value={activeId}
      onChange={(e) => change(e.target.value)}
      className="w-full rounded-md border border-white/15 bg-shadow px-3 py-2 text-sm"
    >
      {(orgs ?? []).map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
      <option value="__new">+ New team…</option>
    </select>
  );
}
