import { can } from "@sendsprite/shared";
import { requireTeam } from "@/lib/session";
import { listDomains } from "@/services/domains";
import { getTeamAws } from "@/services/team-aws";
import { blockDefaults } from "@/lib/editor/blocks";
import { editorLeaf } from "@/lib/editor/tree";
import { TemplateEditor } from "../[slug]/TemplateEditor";

export const metadata = { title: "New template" };

export default async function NewTemplatePage() {
  const ctx = await requireTeam();
  const [domains, aws] = await Promise.all([
    listDomains(ctx.team.id),
    getTeamAws(ctx.team.id),
  ]);
  return (
    <TemplateEditor
      mode="create"
      canManage={can(ctx.role, "templates.manage")}
      userEmail={ctx.session.user.email}
      sesSandbox={aws?.sesAccountStatus !== "production"}
      domains={domains
        .filter((d) => d.status === "verified")
        .map((d) => ({ id: d.id, name: d.name }))}
      template={{
        slug: "",
        name: "",
        subject: "Hello {{name}}",
        // Not read while `nodes` is set — the body is compiled from the
        // blocks — but it is what a switch to HTML mode starts from before
        // anything has been designed.
        bodyHtml: "",
        bodyText: "",
        variables: [],
        // A new template opens in the visual editor. The HTML textarea is
        // still one click away, and a template created through the API keeps
        // working exactly as it did; this is only what the dashboard offers
        // first, and offering a blank `<textarea>` first was the report.
        nodes: [
          editorLeaf({ kind: "heading", level: 2, text: "Hello {{name}}" }),
          editorLeaf(blockDefaults("text")),
        ],
        theme: {},
      }}
    />
  );
}
