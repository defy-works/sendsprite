import { TemplateVariablesPayload } from "@sendsprite/shared";
import { z } from "zod";
import { renderedTemplateOutput } from "./output";
import type { ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/**
 * A dry run. Nothing is sent and nothing is stored, and the output is exactly
 * what `send_email` with the same `template` and `variables` would store — so
 * a model can check its substitution before it reaches a person.
 *
 * The result carries the rendered `subject`, `html` and `text` and nothing
 * else. The variables are **not** echoed back: they are bytes the caller
 * supplied, they are the part of this call most likely to be somebody's
 * personal data, and the caller already has them. If the API ever starts
 * returning them, the narrowing below still keeps them out of the transcript.
 */
export const registerRenderTemplate: ToolRegistration = (server, client) =>
  server.registerTool(
    "render_template",
    {
      title: "Render a template without sending it",
      description:
        "Preview a template with a set of variables. Nothing is sent, nothing is stored and no " +
        "one is mailed. The result is byte-identical to what `send_email` would produce for the " +
        "same `template` and `variables`, so use it to check a substitution first. A missing or " +
        "non-scalar variable is an error naming it — there are no silent blanks. Returns the " +
        "rendered subject, HTML and text only; the variables are not echoed back.",
      inputSchema: {
        // Not `TemplateSlug`: the API resolves a slug *or* a `tpl_…` id, and
        // narrowing to the slug pattern here would refuse an id the caller
        // already holds.
        slug: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .describe("Template slug or `tpl_…` id, from `list_templates`."),
        variables: TemplateVariablesPayload.default({}).describe(
          "Values for the `{{ variable }}` placeholders. Every placeholder the template uses " +
            "must have one, unless it declares a default.",
        ),
      },
      outputSchema: renderedTemplateOutput,
      annotations: { readOnlyHint: true },
    },
    async ({ slug, variables }) => {
      try {
        const { subject, html, text } = await client.templates.render(
          slug,
          variables,
        );
        return toolResult({ subject, html, text });
      } catch (e) {
        return toolError(e);
      }
    },
  );
