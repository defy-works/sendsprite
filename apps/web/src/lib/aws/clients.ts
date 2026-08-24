import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SNSClient } from "@aws-sdk/client-sns";
import { STSClient } from "@aws-sdk/client-sts";
import type { AwsContext } from "./credentials";

/** Factories are the seam for tests (aws-sdk-client-mock mocks the classes). */
export const makeSes = (c: AwsContext) =>
  new SESv2Client({ region: c.region, credentials: c.credentials });
export const makeSns = (c: AwsContext) =>
  new SNSClient({ region: c.region, credentials: c.credentials });
export const makeSts = (c: AwsContext) =>
  new STSClient({ region: c.region, credentials: c.credentials });

export const SES_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "eu-south-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "sa-east-1",
  "af-south-1",
  "me-south-1",
  "il-central-1",
] as const;
export type SesRegion = (typeof SES_REGIONS)[number];
