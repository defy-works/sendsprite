import Link from "next/link";
import { can } from "@sendsprite/shared";
import { Button } from "@/components/ui/Button";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { listTemplates } from "@/services/templates";
import { TemplateList, type TemplateRow } from "./TemplateList";

export const metadata = { title: "Templates" };

export default async function TemplatesPage() {
  const ctx = await requireTeam();
  const canManage = can(ctx.role, "templates.manage");
  const rows: TemplateRow[] = (await listTemplates(ctx.team.id)).map((t) => ({
    slug: t.slug,
    name: t.name,
    subject: t.subject,
    version: t.version,
    updated: formatWhen(t.updatedAt),
  }));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="num-stamp">Templates</p>
          <p className="mt-1 text-sm text-white/60">
            A subject and a body with <code>{"{{variable}}"}</code>{" "}
            placeholders. Send one by naming its slug as <code>template</code>.
          </p>
        </div>
        {canManage && (
          <Button asChild>
            <Link href="/app/templates/new">New template</Link>
          </Button>
        )}
      </div>
      <TemplateList templates={rows} canManage={canManage} />
    </div>
  );
}
