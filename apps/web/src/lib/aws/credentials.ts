import type { SESv2ClientConfig } from "@aws-sdk/client-sesv2";
import { getTeamAws, getTeamAwsSecrets } from "@/services/team-aws";

/** Same smithy credential type every AWS client config accepts. */
export type AwsCredentials = NonNullable<SESv2ClientConfig["credentials"]>;

export interface AwsContext {
  region: string;
  credentials: AwsCredentials;
}

/**
 * The team's stored (encrypted) access key and secret.
 *
 * There is no longer a credential-free mode. `instance_role` meant the SDK's
 * default chain, which resolves to one ambient identity per process and is
 * therefore single-tenant by construction. Callers must check
 * `getTeamAws(teamId)` first; this throws rather than falling back to
 * whatever credentials the host happens to carry, which under multi-tenancy
 * would mean sending from the wrong account.
 */
export async function resolveAwsContext(teamId: string): Promise<AwsContext> {
  const row = await getTeamAws(teamId);
  if (!row) throw new Error("AWS is not connected for this team");
  const sec = await getTeamAwsSecrets(teamId);
  if (!sec) throw new Error("AWS keys missing");
  return {
    region: row.region,
    credentials: {
      accessKeyId: sec.accessKey,
      secretAccessKey: sec.secret,
    },
  };
}
