"use client";
import { useActionState, useState, useTransition } from "react";
import { cancelInvitation, inviteMember } from "./actions";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select } from "@/components/ui/Select";

type Invite = {
  id: string;
  email: string;
  role: string | null;
  /** Pre-formatted on the server so SSR and hydration agree. */
  expires: string;
};

export function InvitePanel({ invites }: { invites: Invite[] }) {
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => inviteMember(fd),
    null,
  );
  const [cancelling, start] = useTransition();
  const [cancelError, setCancelError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex items-end gap-3">
        <div className="flex-1">
          <Label htmlFor="invite-email">Email</Label>
          <Input id="invite-email" name="email" type="email" required />
        </div>
        <div>
          <Label htmlFor="invite-role">Role</Label>
          <Select
            id="invite-role"
            name="role"
            defaultValue="member"
            className="w-40"
            options={[
              { value: "member", label: "Member" },
              { value: "admin", label: "Admin" },
            ]}
          />
        </div>
        <Button type="submit" loading={pending}>
          Invite
        </Button>
      </form>
      {state && !state.ok && (
        <p role="alert" className="text-sm text-red-300">
          {state.error}
        </p>
      )}
      {state && state.ok && (
        <p className="text-sm text-white/70">
          Invitation created. Share this link:{" "}
          <code className="rounded bg-white/8 px-1.5 py-0.5 text-xs select-all">
            {state.data.link}
          </code>
        </p>
      )}
      {invites.length > 0 && (
        <ul className="divide-y divide-white/10">
          {invites.map((i) => (
            <li
              key={i.id}
              className="flex items-center justify-between gap-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate">
                {i.email}{" "}
                <span className="text-white/50">
                  · {i.role ?? "member"} · expires {i.expires}
                </span>
              </span>
              <Button
                size="sm"
                variant="subtle"
                disabled={cancelling}
                onClick={() =>
                  start(async () => {
                    setCancelError(null);
                    try {
                      const res = await cancelInvitation(i.id);
                      if (!res.ok) setCancelError(res.error);
                    } catch {
                      setCancelError("Something went wrong. Please try again.");
                    }
                  })
                }
              >
                Cancel
              </Button>
            </li>
          ))}
        </ul>
      )}
      {cancelError && (
        <p role="alert" className="text-sm text-red-300">
          {cancelError}
        </p>
      )}
    </div>
  );
}
