import type { SESv2ClientConfig } from "@aws-sdk/client-sesv2";
import {
  getDecryptedSecrets,
  getInstanceSettings,
} from "@/services/instance-settings";

/** Same smithy credential type every AWS client config accepts. */
export type AwsCredentials = NonNullable<SESv2ClientConfig["credentials"]>;

export interface AwsContext {
  region: string;
  /**
   * Undefined → SDK default chain. `aws_mode = instance_role` really means
   * "whatever the SDK finds on this host": an EC2/ECS/Lambda role, env vars
   * (`AWS_ACCESS_KEY_ID`…), or a shared profile.
   */
  credentials?: AwsCredentials;
}

/**
 * Where AWS calls get their identity from:
 *  - `keys`: stored (encrypted) access key + secret
 *  - `instance_role`: SDK default chain (EC2/ECS/Lambda role, env, profile)
 *  - `none`: throws — callers must check `awsMode` first
 */
export async function resolveAwsContext(): Promise<AwsContext> {
  const s = await getInstanceSettings();
  if (s.awsMode === "none" || !s.awsRegion)
    throw new Error("AWS is not connected");
  if (s.awsMode === "instance_role") return { region: s.awsRegion };
  const sec = await getDecryptedSecrets();
  if (!sec.awsAccessKey || !sec.awsSecret) throw new Error("AWS keys missing");
  return {
    region: s.awsRegion,
    credentials: {
      accessKeyId: sec.awsAccessKey,
      secretAccessKey: sec.awsSecret,
    },
  };
}
