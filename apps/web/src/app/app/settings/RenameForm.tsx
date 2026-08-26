"use client";
import { useActionState } from "react";
import { renameTeam } from "./actions";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";

export function RenameForm({
  name,
  disabled,
}: {
  name: string;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => renameTeam(fd),
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Label htmlFor="team-name">Team name</Label>
          <Input
            id="team-name"
            name="name"
            defaultValue={name}
            disabled={disabled}
            required
            minLength={2}
            maxLength={64}
          />
        </div>
        <Button type="submit" disabled={disabled || pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
      {state && !state.ok && (
        <p role="alert" className="text-sm text-red-300">
          {state.error}
        </p>
      )}
    </form>
  );
}
