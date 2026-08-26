"use client";
import { useActionState, useState, useTransition } from "react";
import { can, type TeamRole } from "@sendsprite/shared";
import { createApiKey, revokeApiKey, type Result } from "./actions";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { CopyField } from "@/components/ui/CopyField";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Select } from "@/components/ui/Select";

/** Dates are pre-formatted on the server so SSR and hydration agree. */
export type KeyRow = {
  id: string;
  name: string;
  keyPrefix: string;
  permission: "full" | "sending_only";
  domain: string | null;
  lastUsed: string;
  created: string;
  revoked: boolean;
};

export function ApiKeysPanel({
  keys,
  domains,
  role,
}: {
  keys: KeyRow[];
  domains: { id: string; name: string }[];
  role: TeamRole;
}) {
  const canCreate = can(role, "apiKeys.create");
  const canRevoke = can(role, "apiKeys.revoke");
  // The secret lives only in this client state: shown once, gone on reload.
  const [secret, setSecret] = useState<string | null>(null);
  const [state, action, pending] = useActionState(
    async (_prev: unknown, fd: FormData) => {
      const res = await createApiKey(fd);
      if (res.ok) setSecret(res.data.secret);
      return res;
    },
    null,
  );
  const [revoking, start] = useTransition();
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const revoke = (k: KeyRow) => {
    if (!window.confirm(`Revoke "${k.name}"? Requests using it will fail.`))
      return;
    start(async () => {
      setRevokeError(null);
      try {
        const res: Result = await revokeApiKey(k.id);
        if (!res.ok) setRevokeError(res.error);
      } catch {
        setRevokeError("Something went wrong. Please try again.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {canCreate && (
        <Card>
          <CardHeader>
            <CardTitle>Create key</CardTitle>
          </CardHeader>
          <CardBody>
            {secret ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-white/70">
                  Copy it now — we won&apos;t show it again.
                </p>
                <CopyField value={secret} />
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSecret(null)}
                  >
                    Done
                  </Button>
                </div>
              </div>
            ) : (
              <form action={action} className="flex flex-wrap items-end gap-3">
                <div className="min-w-48 flex-1">
                  <Label htmlFor="key-name">Name</Label>
                  <Input
                    id="key-name"
                    name="name"
                    placeholder="production"
                    autoComplete="off"
                    maxLength={64}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="key-permission">Permission</Label>
                  <Select
                    id="key-permission"
                    name="permission"
                    defaultValue="full"
                  >
                    <option value="full">full</option>
                    <option value="sending_only">sending only</option>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="key-domain">Domain</Label>
                  <Select id="key-domain" name="domainId" defaultValue="">
                    <option value="">any</option>
                    {domains.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button type="submit" disabled={pending}>
                  {pending ? "Creating…" : "Create key"}
                </Button>
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

      {keys.length === 0 ? (
        <EmptyState
          title="No API keys yet"
          body={
            canCreate
              ? "Create a key to send email through the REST API or the SMTP relay."
              : "Ask a team owner or admin to create one."
          }
        />
      ) : (
        <div className="glass overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="num-stamp text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Key</th>
                <th className="px-4 py-3 font-medium">Permission</th>
                <th className="px-4 py-3 font-medium">Domain</th>
                <th className="px-4 py-3 font-medium">Last used</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr
                  key={k.id}
                  className={
                    "border-t border-white/8" + (k.revoked ? " opacity-50" : "")
                  }
                >
                  <td className="px-4 py-3 font-medium">{k.name}</td>
                  <td className="px-4 py-3">
                    <code className="text-xs">{k.keyPrefix}…</code>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={k.permission === "full" ? "indigo" : "muted"}
                    >
                      {k.permission === "full" ? "full" : "sending only"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-white/65">
                    {k.domain ?? "any"}
                  </td>
                  <td className="px-4 py-3 text-white/65">{k.lastUsed}</td>
                  <td className="px-4 py-3 text-white/65">{k.created}</td>
                  <td className="px-4 py-3 text-right">
                    {k.revoked ? (
                      <Badge variant="danger">revoked</Badge>
                    ) : (
                      canRevoke && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={revoking}
                          onClick={() => revoke(k)}
                        >
                          Revoke
                        </Button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {revokeError && (
        <p role="alert" className="text-sm text-red-300">
          {revokeError}
        </p>
      )}
    </div>
  );
}
