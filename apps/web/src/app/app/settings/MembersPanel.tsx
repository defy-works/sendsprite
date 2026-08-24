"use client";
import { useState, useTransition } from "react";
import { can, TEAM_ROLES, type TeamRole } from "@sendsprite/shared";
import { changeRole, removeMember } from "./actions";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";

type Member = {
  id: string;
  userId: string;
  role: string;
  email: string;
  name: string | null;
};

export function MembersPanel({
  members,
  me,
  myRole,
}: {
  members: Member[];
  me: string;
  myRole: TeamRole;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const canEdit = can(myRole, "members.changeRole");
  const canRemove = can(myRole, "members.remove");
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Request failed.");
    });
  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-white/10">
        {members.map((m) => {
          const self = m.userId === me;
          return (
            <li
              key={m.id}
              className="flex items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {m.name || m.email}
                  {self && <span className="text-white/50"> (you)</span>}
                </p>
                <p className="truncate text-xs text-white/50">{m.email}</p>
              </div>
              <div className="flex items-center gap-2">
                {canEdit && !self ? (
                  <Select
                    aria-label={`Role for ${m.email}`}
                    className="h-8 w-auto text-xs"
                    value={m.role}
                    disabled={pending}
                    onChange={(e) =>
                      run(() => changeRole(m.id, e.target.value))
                    }
                  >
                    {TEAM_ROLES.map((r) => (
                      <option
                        key={r}
                        value={r}
                        disabled={r === "owner" && myRole !== "owner"}
                      >
                        {r}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Badge variant={m.role === "owner" ? "indigo" : "muted"}>
                    {m.role}
                  </Badge>
                )}
                {canRemove && !self && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => run(() => removeMember(m.id))}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
