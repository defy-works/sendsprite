import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { listSuppressions } from "@/services/suppressions";
import { SuppressionsPanel, type SuppressionRow } from "./SuppressionsPanel";

export const metadata = { title: "Suppressions" };

export default async function SuppressionsPage() {
  const ctx = await requireTeam();
  const rows: SuppressionRow[] = (await listSuppressions(ctx.team.id)).map(
    (s) => ({
      id: s.id,
      email: s.email,
      reason: s.reason,
      note: s.note,
      sourceEmailId: s.sourceEmailId,
      created: formatWhen(s.createdAt),
    }),
  );
  return <SuppressionsPanel suppressions={rows} role={ctx.role} />;
}
