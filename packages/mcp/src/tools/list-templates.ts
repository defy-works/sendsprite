import { pageOutput } from "./output";
import type { ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

/**
 * No arguments: a team has a handful of templates and the answer the model
 * needs — "what can I send, and what does it want?" — is the whole list.
 */
export const registerListTemplates: ToolRegistration = (server, client) =>
  server.registerTool(
    "list_templates",
    {
      title: "List email templates",
      description:
        "List the email templates on this instance. Nothing is sent. Each carries a `slug` (pass " +
        "it as `template` to `send_email`), the `subject` it will use, and a `variablesSchema` " +
        "naming the `{{ variable }}` placeholders its bodies expect. Every placeholder must be " +
        "supplied or the send is refused, so read this before naming a template, and use " +
        "`render_template` to check a substitution before mailing it to a person.",
      outputSchema: pageOutput,
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return toolResult(await client.templates.list());
      } catch (e) {
        return toolError(e);
      }
    },
  );
