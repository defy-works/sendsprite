import { notFound } from "next/navigation";
import { can } from "@sendsprite/shared";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { getTemplate, listTemplateVersions } from "@/services/templates";
import { variableRowsOf } from "../preview";
import { TemplateEditor } from "./TemplateEditor";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return { title: `Template ${slug}` };
}

export default async function TemplatePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const ctx = await requireTeam();
  // Reading is not gated: the whole team can see a template, the way the
  // whole team can see the suppression list. Only the mutations are gated,
  // and they are gated in the service.
  const t = await getTemplate(ctx.team.id, slug);
  if (!t) notFound();
  const versions = await listTemplateVersions(ctx.team.id, t.id);
  return (
    <TemplateEditor
      mode="edit"
      canManage={can(ctx.role, "templates.manage")}
      version={t.version}
      template={{
        slug: t.slug,
        name: t.name,
        subject: t.subject,
        bodyHtml: t.bodyHtml,
        bodyText: t.bodyText ?? "",
        variables: variableRowsOf(t.variablesSchema),
      }}
      versions={versions.map((v) => ({
        version: v.version,
        created: formatWhen(v.createdAt),
      }))}
    />
  );
}
