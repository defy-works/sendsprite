"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { updateInstanceAction } from "./actions";
import { Field } from "@/components/ui/Field";
import { Switch } from "@/components/ui/Toggle";
import { Alert, Notice } from "@/app/setup/steps/shared";

export function InstanceForm({
  signupMode,
  landingEnabled,
  retentionDays,
  defaultDailyLimit,
  defaultMonthlyLimit,
  envSignupMode,
}: {
  signupMode: "open" | "invite" | "closed" | "auto";
  landingEnabled: boolean;
  retentionDays: number;
  defaultDailyLimit: number | null;
  defaultMonthlyLimit: number | null;
  envSignupMode: "open" | "invite" | "closed" | "auto";
}) {
  const [landing, setLanding] = useState(landingEnabled);
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
      <Field
        id="signupMode"
        label="Signup mode"
        hint="Who may create an account on this deployment."
      >
        <Select
          id="signupMode"
          name="signupMode"
          defaultValue={signupMode}
          options={[
            {
              value: "auto",
              label: "Auto",
              hint: "Open until the first account exists, invite-only after",
            },
            { value: "open", label: "Open", hint: "Anyone may sign up" },
            {
              value: "invite",
              label: "Invite only",
              hint: "A pending invitation is required",
            },
            { value: "closed", label: "Closed", hint: "No new accounts" },
          ]}
        />
      </Field>
      <Switch
        name="landingEnabled"
        checked={landing}
        onChange={setLanding}
        label="Landing page"
        hint="Off serves the sign-in page at the root instead. Falls back to the LANDING_ENABLED environment variable when this has never been set."
      />
      <Field
        id="retentionDays"
        label="Maximum retention (days)"
        hint="The longest window any team may keep email logs for (1–3650). A team can choose a shorter one in its own settings; nothing may exceed this. Bodies and attachments are purged nightly; metadata and events stay."
      >
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
      </Field>
      {/* The floor under a team nobody has decided about. A team's own
          override still wins, and so does a plan — this is what an instance
          with open signup applies until somebody looks. */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="defaultDailyLimit"
          label="Default daily limit"
          hint="Applied to a team with no limit of its own. Blank for none."
        >
          <Input
            id="defaultDailyLimit"
            name="defaultDailyLimit"
            type="number"
            min={1}
            step={1}
            placeholder="No limit"
            defaultValue={defaultDailyLimit ?? ""}
          />
        </Field>
        <Field
          id="defaultMonthlyLimit"
          label="Default monthly limit"
          hint="The same, per calendar month. A plan's allowance wins over this."
        >
          <Input
            id="defaultMonthlyLimit"
            name="defaultMonthlyLimit"
            type="number"
            min={1}
            step={1}
            placeholder="No limit"
            defaultValue={defaultMonthlyLimit ?? ""}
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending}>
          Save
        </Button>
        {state?.ok && <span className="text-sm text-white/65">Saved.</span>}
      </div>
      {state && !state.ok && <Alert>{state.error}</Alert>}
    </form>
  );
}
