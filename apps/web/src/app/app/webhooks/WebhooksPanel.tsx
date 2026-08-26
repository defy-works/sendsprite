"use client";
import { useActionState, useState } from "react";
import { can, WEBHOOK_EVENT_TYPES, type TeamRole } from "@sendsprite/shared";
import { createWebhook } from "./actions";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Link } from "@/components/ui/Link";
import { Checkbox } from "@/components/ui/Toggle";

/** Dates are pre-formatted on the server so SSR and hydration agree. */
export type WebhookRow = {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  disabledReason: string | null;
  failingSince: string | null;
  created: string;
};

export function WebhookStatus({
  enabled,
  disabledReason,
  failingSince,
}: Pick<WebhookRow, "enabled" | "disabledReason" | "failingSince">) {
  if (!enabled)
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Badge variant="danger">disabled</Badge>
        {disabledReason && (
          <span className="text-xs text-white/50">{disabledReason}</span>
        )}
      </span>
    );
  if (failingSince)
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <Badge variant="warning">failing</Badge>
        <span className="text-xs text-white/50">since {failingSince}</span>
      </span>
    );
  return <Badge variant="success">enabled</Badge>;
}

export function WebhooksPanel({
  webhooks,
  role,
}: {
  webhooks: WebhookRow[];
  role: TeamRole;
}) {
  const canManage = can(role, "webhooks.manage");
  // The secret lives only in this client state: shown once, gone on reload.
  const [secret, setSecret] = useState<string | null>(null);
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => {
      const res = await createWebhook(fd);
      if (res.ok) setSecret(res.data.secret);
      return res;
    },
    null,
  );

  return (
    <div className="flex flex-col gap-6">
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Add endpoint</CardTitle>
          </CardHeader>
          <CardBody>
            {secret ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-white/70">
                  Signing secret — copy it now, we won&apos;t show it again.
                  Verify the <code>sendsprite-signature</code> header with it.
                </p>
                <CopyField value={secret} />
                <div>
                  <Button
                    size="sm"
                    variant="subtle"
                    onClick={() => setSecret(null)}
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <form action={action} className="flex flex-col gap-4">
                <div>
                  <Label htmlFor="wh-url">Endpoint URL</Label>
                  <Input
                    id="wh-url"
                    name="url"
                    type="url"
                    placeholder="https://example.com/webhooks/sendsprite"
                    autoComplete="off"
                    required
                  />
                </div>
                <fieldset>
                  <legend className="mb-2 text-sm font-medium">Events</legend>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {WEBHOOK_EVENT_TYPES.map((t) => (
                      <Checkbox
                        key={t}
                        name="events"
                        value={t}
                        label={<code className="text-xs">{t}</code>}
                      />
                    ))}
                  </div>
                </fieldset>
                <div>
                  <Button type="submit" loading={pending}>
                    Add endpoint
                  </Button>
                </div>
              </form>
            )}
            {state && !state.ok && (
              <p role="alert" className="mt-3 text-sm text-red-300">
                {state.error}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {webhooks.length === 0 ? (
        <EmptyState
          title="No webhooks yet"
          body={
            canManage
              ? "Add an endpoint to receive signed events as email is delivered, bounces or is complained about."
              : "Ask a team owner or admin to add one."
          }
        />
      ) : (
        <div className="glass overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="num-stamp text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Endpoint</th>
                <th className="px-4 py-3 font-medium">Events</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {webhooks.map((w) => (
                <tr key={w.id} className="border-t border-white/8">
                  <td className="px-4 py-3">
                    <Link href={`/app/webhooks/${w.id}`} className="break-all">
                      {w.url}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {w.events.map((e) => (
                        <Badge key={e} variant="muted">
                          {e}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <WebhookStatus {...w} />
                  </td>
                  <td className="px-4 py-3 text-white/65">{w.created}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
