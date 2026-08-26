"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Alert } from "@/app/setup/steps/shared";
import { replayDelivery } from "../actions";

/** Dates are pre-formatted on the server so SSR and hydration agree. */
export type DeliveryRow = {
  id: string;
  eventType: string;
  attempt: number;
  status: "pending" | "delivered" | "failed" | "exhausted";
  statusCode: number | null;
  excerpt: string | null;
  when: string;
  nextRetry: string | null;
};

const VARIANT: Record<DeliveryRow["status"], BadgeVariant> = {
  pending: "warning",
  delivered: "success",
  failed: "danger",
  exhausted: "danger",
};

export function DeliveriesTable({
  webhookId,
  deliveries,
  canReplay,
}: {
  webhookId: string;
  deliveries: DeliveryRow[];
  canReplay: boolean;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const replay = (d: DeliveryRow) =>
    start(async () => {
      setError(null);
      try {
        const res = await replayDelivery(webhookId, d.id);
        if (!res.ok) setError(res.error);
        else router.refresh();
      } catch {
        setError("Something went wrong. Please try again.");
      }
    });

  if (deliveries.length === 0)
    return (
      <EmptyState
        title="No deliveries yet"
        body="Deliveries appear here as subscribed events happen. Send a test event to check the endpoint."
      />
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="num-stamp text-left">
            <tr>
              <th className="px-4 py-3 font-medium">Event</th>
              <th className="px-4 py-3 font-medium">Attempt</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Code</th>
              <th className="px-4 py-3 font-medium">Time</th>
              {canReplay && <th className="px-4 py-3" />}
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => (
              <tr key={d.id} className="border-t border-white/8">
                <td className="px-4 py-3">
                  <code className="text-xs">{d.eventType}</code>
                </td>
                <td className="px-4 py-3 text-white/65">{d.attempt}</td>
                <td className="px-4 py-3">
                  <Badge variant={VARIANT[d.status]}>{d.status}</Badge>
                  {d.status === "pending" && d.nextRetry && (
                    <span className="ml-2 text-xs text-white/50">
                      retry {d.nextRetry}
                    </span>
                  )}
                </td>
                <td
                  className="px-4 py-3 text-white/65"
                  title={d.excerpt ?? undefined}
                >
                  {d.statusCode ?? "—"}
                </td>
                <td className="px-4 py-3 text-white/65">{d.when}</td>
                {canReplay && (
                  <td className="px-4 py-3 text-right">
                    <Button
                      size="sm"
                      variant="subtle"
                      disabled={busy}
                      onClick={() => replay(d)}
                    >
                      Replay
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
