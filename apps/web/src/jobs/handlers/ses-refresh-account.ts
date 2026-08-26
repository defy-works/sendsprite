import { registerQueue } from "../boss";
import { Q } from "../queues";
import { getInstanceSettings } from "@/services/instance-settings";
import { refreshSesAccount } from "@/services/aws-connect";

registerQueue(
  Q.sesRefreshAccount,
  async () => {
    const s = await getInstanceSettings();
    if (s.awsMode === "none") return;
    const r = await refreshSesAccount();
    if (!r.ok) console.warn("[ses] account refresh failed:", r.error);
  },
  // retryLimit 0: a failed check is simply retried by the next tick.
  // :17 keeps the GetAccount call off the top-of-the-hour crowd.
  { cron: "17 * * * *", queue: { retryLimit: 0 } },
);
