"use client";
import { useActionState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { updateOrgOverrides } from "../../actions-org";

/**
 * The operator's per-team escape hatches.
 *
 * `team_settings.daily_limit` and `monthly_limit` already beat the billing
 * plan in `resolveTeamCaps` — they were the documented escape hatch with no
 * way to reach them short of `psql`. Empty means "no override", which is a
 * different thing from `0`: zero is a real cap that stops the team sending, so
 * the field cannot use a placeholder as its unset value.
 */
export function OverridesForm({
  teamId,
  dailyLimit,
  monthlyLimit,
  retentionDays,
  instanceRetentionMax,
}: {
  teamId: string;
  dailyLimit: number | null;
  monthlyLimit: number | null;
  retentionDays: number | null;
  instanceRetentionMax: number;
}) {
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => updateOrgOverrides(teamId, fd),
    null,
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <p className="text-sm text-white/65">
        Leave a field empty to remove the override. A limit set here wins over
        the team&apos;s billing plan, column by column — lifting a monthly cap
        does not touch the daily one.
      </p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field id="dailyLimit" label="Daily limit" hint="Emails per UTC day.">
          <Input
            id="dailyLimit"
            name="dailyLimit"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="no override"
            defaultValue={dailyLimit ?? ""}
          />
        </Field>
        <Field
          id="monthlyLimit"
          label="Monthly limit"
          hint="Overrides the plan allowance."
        >
          <Input
            id="monthlyLimit"
            name="monthlyLimit"
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            placeholder="from plan"
            defaultValue={monthlyLimit ?? ""}
          />
        </Field>
        <Field
          id="retentionDays"
          label="Retention (days)"
          hint={`Instance maximum is ${instanceRetentionMax}.`}
        >
          <Input
            id="retentionDays"
            name="retentionDays"
            type="number"
            min={1}
            max={instanceRetentionMax}
            step={1}
            inputMode="numeric"
            placeholder={String(instanceRetentionMax)}
            defaultValue={retentionDays ?? ""}
          />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending}>
          Save overrides
        </Button>
        {state?.ok && <span className="text-sm text-white/65">Saved.</span>}
      </div>
      {state && !state.ok && <Alert>{state.error}</Alert>}
    </form>
  );
}
