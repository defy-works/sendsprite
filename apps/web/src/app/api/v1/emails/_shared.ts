import type { ApiAuthOk } from "@/lib/api-auth";
import type { SendContext } from "@/services/emails";

export const sendContext = (auth: ApiAuthOk): SendContext => ({
  teamId: auth.team.id,
  source: "api",
  apiKeyId: auth.key.id,
  actorUserId: null,
  keyDomainId: auth.key.domainId,
  permission: auth.key.permission,
});
