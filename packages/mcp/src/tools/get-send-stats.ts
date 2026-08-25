import type { ToolRegistration } from "./register";
import { toolError, toolResult } from "./result";

export const registerGetSendStats: ToolRegistration = (server, client) =>
  server.registerTool(
    "get_send_stats",
    {
      title: "Get send and deliverability stats",
      description:
        "Aggregate counters for the team: emails sent today, over 7 days and over 30 days; " +
        "30-day delivered/bounced/complained rates; and any account-health alerts (a bounce or " +
        "complaint rate high enough to put sending at risk).",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return toolResult(await client.stats());
      } catch (e) {
        return toolError(e);
      }
    },
  );
