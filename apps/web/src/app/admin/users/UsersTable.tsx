"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/confirm";
import { usePrompt } from "@/components/ui/prompt";
import { useToast } from "@/components/ui/toast";
import { banUser, promoteUser } from "../actions-org";

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  instanceAdmin: boolean;
  createdAt: string;
  teams: number;
  /** Admin through `INSTANCE_ADMIN_EMAILS`; the flag cannot revoke that. */
  envAdmin: boolean;
  banned: boolean;
  bannedReason: string | null;
}

const date = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso));

export function UsersTable({
  users,
  me,
}: {
  users: AdminUserRow[];
  me: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = async (u: AdminUserRow) => {
    const granting = !u.instanceAdmin;
    const ok = await confirm({
      title: granting
        ? `Make ${u.email} an instance admin?`
        : `Remove instance admin from ${u.email}?`,
      body: granting
        ? "They will be able to read and change settings for every team on this deployment, suspend sending, and promote other admins. This is the highest privilege here."
        : "They lose access to these pages. Anything they own in their own teams is untouched.",
      confirmLabel: granting ? "Grant admin" : "Remove admin",
      tone: granting ? "danger" : "default",
    });
    if (!ok) return;
    start(async () => {
      setError(null);
      try {
        const res = await promoteUser(u.id, granting);
        if (!res.ok) return setError(res.error);
        toast({
          tone: "success",
          title: granting ? "Instance admin granted" : "Instance admin removed",
          body: u.email,
        });
        router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });
  };

  const setBanned = async (u: AdminUserRow) => {
    const banning = !u.banned;
    if (!banning) {
      const ok = await confirm({
        title: `Let ${u.email} back in?`,
        body: "They can sign in again immediately. Their teams were never stopped from sending — that is a separate suspension.",
        confirmLabel: "Lift the ban",
      });
      if (!ok) return;
      return run(u, false, null);
    }
    const reason = await prompt({
      title: `Ban ${u.email}?`,
      body: "They are signed out everywhere and cannot sign in again. Their teams keep sending: stopping a customer's mail is a suspension on the team, and a separate decision. The reason below is shown to them.",
      confirmLabel: "Ban this account",
      tone: "danger",
    });
    if (reason === null) return;
    return run(u, true, reason);
  };

  const run = (u: AdminUserRow, banned: boolean, reason: string | null) =>
    start(async () => {
      setError(null);
      try {
        const res = await banUser(u.id, banned, reason);
        if (!res.ok) return setError(res.error);
        toast({
          tone: banned ? "error" : "success",
          title: banned ? "Account banned" : "Ban lifted",
          body: u.email,
        });
        router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="glass overflow-x-auto p-0">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left">
              <th className="px-4 py-2.5 text-[11px] font-medium tracking-[0.14em] text-white/40 uppercase">
                Account
              </th>
              <th className="px-4 py-2.5 text-[11px] font-medium tracking-[0.14em] text-white/40 uppercase">
                Teams
              </th>
              <th className="px-4 py-2.5 text-[11px] font-medium tracking-[0.14em] text-white/40 uppercase">
                Joined
              </th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {users.map((u, i) => (
              <tr
                key={u.id}
                className="fade-up border-b border-white/5 transition-colors last:border-0 hover:bg-white/4"
                style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}
              >
                <td className="px-4 py-3">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{u.name || u.email}</span>
                    {u.instanceAdmin && (
                      <Badge variant="indigo">Instance admin</Badge>
                    )}
                    {u.envAdmin && <Badge variant="muted">via env</Badge>}
                    {u.id === me && <Badge variant="muted">You</Badge>}
                    {u.banned && <Badge variant="danger">Banned</Badge>}
                  </p>
                  {u.banned && u.bannedReason && (
                    <p className="text-xs text-red-300/80">{u.bannedReason}</p>
                  )}
                  {u.name && <p className="text-xs text-white/45">{u.email}</p>}
                </td>
                <td className="tnum px-4 py-3 text-white/70">{u.teams}</td>
                <td className="px-4 py-3 text-white/55">{date(u.createdAt)}</td>
                <td className="px-4 py-3 text-right">
                  <Button
                    size="sm"
                    variant={u.instanceAdmin ? "subtle" : "secondary"}
                    // Removing your own flag is refused by the service too;
                    // disabling it here means the refusal is never a surprise.
                    disabled={pending || (u.instanceAdmin && u.id === me)}
                    title={
                      u.instanceAdmin && u.id === me
                        ? "Ask another admin to remove your own flag."
                        : undefined
                    }
                    onClick={() => void toggle(u)}
                  >
                    {u.instanceAdmin ? "Remove admin" : "Make admin"}
                  </Button>
                  <Button
                    size="sm"
                    variant={u.banned ? "subtle" : "dangerSubtle"}
                    className="ml-2"
                    // An instance admin cannot be banned by the service
                    // either: banning an operator out of the surface that
                    // unbans them is not recoverable from here.
                    disabled={
                      pending || u.id === me || (!u.banned && u.instanceAdmin)
                    }
                    title={
                      u.instanceAdmin && !u.banned
                        ? "Remove the instance-admin flag first."
                        : undefined
                    }
                    onClick={() => void setBanned(u)}
                  >
                    {u.banned ? "Unban" : "Ban"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
