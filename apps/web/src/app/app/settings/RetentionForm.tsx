"use client";
import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Alert } from "@/app/setup/steps/shared";
import { updateRetentionAction } from "./actions";

export function RetentionForm({
  retentionDays,
  instanceMax,
  canManage,
}: {
  retentionDays: number;
  instanceMax: number;
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => updateRetentionAction(fd),
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="retentionDays">Retention (days)</Label>
        <Input
          id="retentionDays"
          name="retentionDays"
          type="number"
          min={1}
          max={instanceMax}
          step={1}
          required
          disabled={!canManage}
          defaultValue={retentionDays}
          className="max-w-40"
        />
        <p className="mt-1 text-xs text-white/50">
          How long this team&apos;s email bodies and attachments are kept (1–
          {instanceMax}). This instance allows at most {instanceMax} days.
          Metadata and events are never purged.
        </p>
      </div>
      {canManage && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {state?.ok && <span className="text-sm text-white/65">Saved.</span>}
        </div>
      )}
      {state && !state.ok && <Alert>{state.error}</Alert>}
    </form>
  );
}
