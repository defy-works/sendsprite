import { notFound } from "next/navigation";
import { can } from "@sendsprite/shared";
import { formatWhen } from "@/lib/format";
import { requireTeam } from "@/lib/session";
import { listDomains } from "@/services/domains";
import { getTemplate, listTemplateVersions } from "@/services/templates";
import { getTeamAws } from "@/services/team-aws";
import { editorNodesOf } from "@/lib/editor/tree";
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
  const [versions, domains, aws] = await Promise.all([
    listTemplateVersions(ctx.team.id, t.id),
    listDomains(ctx.team.id),
    getTeamAws(ctx.team.id),
  ]);
  return (
    <TemplateEditor
      mode="edit"
      canManage={can(ctx.role, "templates.manage")}
      userEmail={ctx.session.user.email}
      sesSandbox={aws?.sesAccountStatus !== "production"}
      domains={domains
        .filter((d) => d.status === "verified")
        .map((d) => ({ id: d.id, name: d.name }))}
      version={t.version}
      template={{
        slug: t.slug,
        name: t.name,
        subject: t.subject,
        bodyHtml: t.bodyHtml,
        bodyText: t.bodyText ?? "",
        variables: variableRowsOf(t.variablesSchema),
        // Present means this template was built in the visual editor and
        // reopens there; null means it was written as HTML.
        nodes: t.design ? editorNodesOf(t.design) : null,
        theme: t.theme ?? {},
      }}
      versions={versions.map((v) => ({
        version: v.version,
        created: formatWhen(v.createdAt),
      }))}
    />
  );
}
