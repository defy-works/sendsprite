import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { listWebhooks } from "@/services/webhooks";
import { WebhooksPanel, type WebhookRow } from "./WebhooksPanel";

export const metadata = { title: "Webhooks" };

export default async function WebhooksPage() {
  const ctx = await requireTeam();
  const rows: WebhookRow[] = (await listWebhooks(ctx.team.id)).map((w) => ({
    id: w.id,
    url: w.url,
    events: w.events,
    enabled: w.enabled,
    disabledReason: w.disabledReason,
    failingSince: w.failingSince ? formatWhen(w.failingSince) : null,
    created: formatWhen(w.createdAt),
  }));
  return <WebhooksPanel webhooks={rows} role={ctx.role} />;
}
