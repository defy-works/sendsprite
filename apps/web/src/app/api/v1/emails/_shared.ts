import type { ApiAuthOk } from "@/lib/api-auth";
import { fail } from "@/lib/api-response";
import type { SendContext, SendFailure } from "@/services/emails";

export const sendContext = (auth: ApiAuthOk): SendContext => ({
  teamId: auth.team.id,
  source: "api",
  apiKeyId: auth.key.id,
  actorUserId: null,
  keyDomainId: auth.key.domainId,
});

/** A typed service refusal → the error envelope (status from the code). */
export const sendFailure = (r: SendFailure, headers: HeadersInit) =>
  fail(r.code, r.error, r.details, headers);
