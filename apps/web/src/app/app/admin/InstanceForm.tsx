"use client";
import { useActionState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select } from "@/components/ui/Select";
import { updateInstanceAction } from "./actions";
import { Alert, Notice } from "@/app/setup/steps/shared";

export function InstanceForm({
  signupMode,
  landingEnabled,
  retentionDays,
  envSignupMode,
}: {
  signupMode: "open" | "invite" | "closed" | "auto";
  landingEnabled: boolean;
  retentionDays: number;
  envSignupMode: "open" | "invite" | "closed" | "auto";
}) {
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => updateInstanceAction(fd),
    null,
  );
  return (
    <form action={action} className="flex flex-col gap-4">
      {envSignupMode !== "auto" && (
        <Notice>
          SIGNUP_MODE={envSignupMode} is set in the environment and overrides
          the value below.
        </Notice>
      )}
      <div>
        <Label htmlFor="signupMode">Signup mode</Label>
        <Select id="signupMode" name="signupMode" defaultValue={signupMode}>
          <option value="auto">Auto (invite-only once a user exists)</option>
          <option value="open">Open</option>
          <option value="invite">Invite only</option>
          <option value="closed">Closed</option>
        </Select>
      </div>
      <label className="flex items-center gap-2 text-sm text-white/75">
        <input
          type="checkbox"
          name="landingEnabled"
          value="on"
          defaultChecked={landingEnabled}
          className="accent-indigo-500"
        />
        Landing page (falls back to LANDING_ENABLED env when unset)
      </label>
      <div>
        <Label htmlFor="retentionDays">Maximum retention (days)</Label>
        <Input
          id="retentionDays"
          name="retentionDays"
          type="number"
          min={1}
          max={3650}
          step={1}
          required
          defaultValue={retentionDays}
          className="max-w-40"
        />
        <p className="mt-1 text-xs text-white/50">
          The longest window any team may keep email logs for (1–3650). A team
          can choose a shorter one in its own settings; nothing may exceed this.
          Bodies and attachments are purged nightly; metadata and events stay.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {state?.ok && <span className="text-sm text-white/65">Saved.</span>}
      </div>
      {state && !state.ok && <Alert>{state.error}</Alert>}
    </form>
  );
}
