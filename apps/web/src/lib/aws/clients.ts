import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SNSClient } from "@aws-sdk/client-sns";
import { STSClient } from "@aws-sdk/client-sts";
import type { AwsContext } from "./credentials";

export { SES_REGIONS, type SesRegion } from "./regions";

/** Factories are the seam for tests (aws-sdk-client-mock mocks the classes). */
export const makeSes = (c: AwsContext) =>
  new SESv2Client({ region: c.region, credentials: c.credentials });
export const makeSns = (c: AwsContext) =>
  new SNSClient({ region: c.region, credentials: c.credentials });
export const makeSts = (c: AwsContext) =>
  new STSClient({ region: c.region, credentials: c.credentials });
