import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { PageHeader } from "@/components/ui/PageHeader";
import { IconSearch } from "@/components/ui/icons";
import { loadEnv } from "@/env.schema";
import { parseAdminEmails } from "@/lib/instance-admin";
import { requireInstanceAdmin } from "@/lib/session";
import { listUsers } from "@/services/admin";
import { UsersTable } from "./UsersTable";

export const metadata = { title: "Users" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const s = await requireInstanceAdmin();
  const q = (await searchParams).q ?? "";
  const [users, envAdmins] = await Promise.all([
    listUsers(q),
    Promise.resolve(parseAdminEmails(loadEnv().INSTANCE_ADMIN_EMAILS)),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Users"
        description="Every account on this instance, and who may reach these pages."
      />

      {envAdmins.length > 0 && (
        <p className="rounded-md border border-white/10 bg-white/4 px-3.5 py-2.5 text-sm text-white/65">
          {envAdmins.length === 1
            ? "One address is"
            : `${envAdmins.length} addresses are`}{" "}
          also admin through <code>INSTANCE_ADMIN_EMAILS</code>. That list is
          the lock-out recovery path and cannot be changed from here — only from
          the environment.
        </p>
      )}

      <form method="get" className="relative max-w-sm">
        <IconSearch className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-white/35" />
        <Input
          name="q"
          defaultValue={q}
          placeholder="Search by email or name"
          aria-label="Search users"
          className="pl-9"
        />
      </form>

      {users.length === 0 ? (
        <EmptyState
          eyebrow="No match"
          title={q ? `Nothing matches "${q}"` : "No accounts yet"}
        />
      ) : (
        <UsersTable
          users={users.map(({ bannedAt, ...u }) => ({
            ...u,
            createdAt: u.createdAt.toISOString(),
            envAdmin: envAdmins.includes(u.email.toLowerCase()),
            // A boolean crosses into the client tree; the timestamp is not
            // shown and a Date would have to be serialised for nothing.
            banned: bannedAt !== null,
          }))}
          me={s.user.id}
        />
      )}
    </div>
  );
}
