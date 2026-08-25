"use client";
import NextLink from "next/link";
import { useActionState, useState, useTransition } from "react";
import { can, type TeamRole } from "@sendsprite/shared";
import type { SuppressionReason } from "@/services/suppressions";
import { addSuppression, removeSuppression, type Result } from "./actions";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select } from "@/components/ui/Select";

/** Dates are pre-formatted on the server so SSR and hydration agree. */
export type SuppressionRow = {
  id: string;
  email: string;
  reason: SuppressionReason;
  note: string | null;
  sourceEmailId: string | null;
  created: string;
};

const REASON_VARIANT: Record<SuppressionReason, BadgeVariant> = {
  bounce: "danger",
  complaint: "danger",
  unsubscribe: "warning",
  manual: "muted",
};

export function SuppressionsPanel({
  suppressions,
  role,
}: {
  suppressions: SuppressionRow[];
  role: TeamRole;
}) {
  const canAdd = can(role, "contacts.manage");
  const canRemove = can(role, "settings.manage");
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => addSuppression(fd),
    null,
  );
  const [removing, start] = useTransition();
  const [removeError, setRemoveError] = useState<string | null>(null);
  const remove = (s: SuppressionRow) => {
    if (!window.confirm(`Remove ${s.email} from the suppression list?`)) return;
    start(async () => {
      setRemoveError(null);
      try {
        const res: Result = await removeSuppression(s.email);
        if (!res.ok) setRemoveError(res.error);
      } catch {
        setRemoveError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {canAdd && (
        <Card>
          <CardHeader>
            <CardTitle>Suppress an address</CardTitle>
          </CardHeader>
          <CardBody>
            <form action={action} className="flex flex-wrap items-end gap-3">
              <div className="min-w-48 flex-1">
                <Label htmlFor="sup-email">Email</Label>
                <Input
                  id="sup-email"
                  name="email"
                  type="email"
                  placeholder="someone@example.com"
                  autoComplete="off"
                  required
                />
              </div>
              <div>
                <Label htmlFor="sup-reason">Reason</Label>
                <Select id="sup-reason" name="reason" defaultValue="manual">
                  <option value="manual">manual</option>
                  <option value="unsubscribe">unsubscribe</option>
                </Select>
              </div>
              <div className="min-w-48 flex-1">
                <Label htmlFor="sup-note">Note</Label>
                <Input
                  id="sup-note"
                  name="note"
                  placeholder="optional"
                  autoComplete="off"
                  maxLength={500}
                />
              </div>
              <Button type="submit" disabled={pending}>
                {pending ? "Adding…" : "Suppress"}
              </Button>
            </form>
            {state && !state.ok && (
              <p role="alert" className="mt-3 text-sm text-red-300">
                {state.error}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {suppressions.length === 0 ? (
        <EmptyState
          title="No suppressed addresses"
          body="Bounces and complaints from SES land here automatically; you can also add addresses by hand."
        />
      ) : (
        <div className="glass overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="num-stamp text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Reason</th>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Note</th>
                <th className="px-4 py-3 font-medium">Added</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {suppressions.map((s) => (
                <tr key={s.id} className="border-t border-white/8">
                  <td className="px-4 py-3 font-medium">{s.email}</td>
                  <td className="px-4 py-3">
                    <Badge variant={REASON_VARIANT[s.reason]}>{s.reason}</Badge>
                  </td>
                  <td className="px-4 py-3 text-white/65">
                    {s.sourceEmailId ? (
                      <NextLink
                        href={`/app/emails/${s.sourceEmailId}`}
                        className="underline decoration-white/30 underline-offset-2 hover:text-white"
                      >
                        <code className="text-xs">{s.sourceEmailId}</code>
                      </NextLink>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-white/65">{s.note ?? "—"}</td>
                  <td className="px-4 py-3 text-white/65">{s.created}</td>
                  <td className="px-4 py-3 text-right">
                    {canRemove && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={removing}
                        onClick={() => remove(s)}
                      >
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {removeError && (
        <p role="alert" className="text-sm text-red-300">
          {removeError}
        </p>
      )}
    </div>
  );
}
