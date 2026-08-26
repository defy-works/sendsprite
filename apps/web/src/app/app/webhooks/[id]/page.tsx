import { notFound } from "next/navigation";
import { can } from "@sendsprite/shared";
import { Badge } from "@/components/ui/Badge";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import { Link } from "@/components/ui/Link";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { getWebhook, listDeliveries } from "@/services/webhooks";
import { WebhookStatus } from "../WebhooksPanel";
import { DeliveriesTable, type DeliveryRow } from "./DeliveriesTable";
import { WebhookActions } from "./WebhookActions";

export default async function WebhookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const ctx = await requireTeam();
  const { id } = await params;
  const w = await getWebhook(ctx.team.id, id);
  if (!w) notFound();
  const canManage = can(ctx.role, "webhooks.manage");
  const deliveries: DeliveryRow[] = (await listDeliveries(ctx.team.id, id)).map(
    (d) => ({
      id: d.id,
      eventType: d.eventType,
      attempt: d.attempt,
      status: d.status,
      statusCode: d.statusCode,
      excerpt: d.responseExcerpt,
      when: formatWhen(d.deliveredAt ?? d.createdAt),
      nextRetry: d.nextRetryAt ? formatWhen(d.nextRetryAt) : null,
    }),
  );
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/app/webhooks" className="num-stamp no-underline">
          ← Webhooks
        </Link>
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="break-all text-lg font-medium">{w.url}</h1>
          <WebhookStatus
            enabled={w.enabled}
            disabledReason={w.disabledReason}
            failingSince={w.failingSince ? formatWhen(w.failingSince) : null}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {w.events.map((e) => (
            <Badge key={e} variant="muted">
              {e}
            </Badge>
          ))}
        </div>
      </div>
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
          </CardHeader>
          <CardBody>
            <WebhookActions id={w.id} url={w.url} enabled={w.enabled} />
          </CardBody>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Recent deliveries</CardTitle>
        </CardHeader>
        <CardBody>
          <DeliveriesTable
            webhookId={w.id}
            deliveries={deliveries}
            canReplay={canManage}
          />
        </CardBody>
      </Card>
    </div>
  );
}
