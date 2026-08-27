import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { listApiKeys } from "@/services/api-keys";
import { listDomains } from "@/services/domains";
import { ApiKeysPanel, type KeyRow } from "./ApiKeysPanel";

export const metadata = { title: "API keys" };

export default async function ApiKeysPage() {
  const ctx = await requireTeam();
  const [keys, domains] = await Promise.all([
    listApiKeys(ctx.team.id),
    listDomains(ctx.team.id),
  ]);
  const domainName = new Map(domains.map((d) => [d.id, d.name]));
  const rows: KeyRow[] = keys.map((k) => ({
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    permission: k.permission,
    domain: k.domainId ? (domainName.get(k.domainId) ?? null) : null,
    lastUsed: formatWhen(k.lastUsedAt),
    created: formatWhen(k.createdAt),
    revoked: Boolean(k.revokedAt),
  }));
  return (
    <ApiKeysPanel
      keys={rows}
      domains={domains.map((d) => ({ id: d.id, name: d.name }))}
      role={ctx.role}
    />
  );
}
