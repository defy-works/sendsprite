import { can } from "@sendsprite/shared";
import { requireTeam } from "@/lib/session";
import { TemplateEditor } from "../[slug]/TemplateEditor";

export const metadata = { title: "New template" };

export default async function NewTemplatePage() {
  const ctx = await requireTeam();
  return (
    <TemplateEditor
      mode="create"
      canManage={can(ctx.role, "templates.manage")}
    />
  );
}
