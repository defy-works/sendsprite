import { SESv2Client } from "@aws-sdk/client-sesv2";
import { SNSClient } from "@aws-sdk/client-sns";
import { STSClient } from "@aws-sdk/client-sts";
import type { AwsContext } from "./credentials";
import { FakeAwsClient } from "./fake-client";

export { SES_REGIONS, type SesRegion } from "./regions";

/**
 * E2E seam: the Playwright suite runs a real server against a fake AWS.
 * Both conditions are required so the fake can never activate in a
 * production build, whatever the environment says.
 */
const e2eMock = () =>
  process.env.AWS_E2E_MOCK === "1" && process.env.NODE_ENV !== "production";

/** Factories are the seam for tests (aws-sdk-client-mock mocks the classes). */
export const makeSes = (c: AwsContext) =>
  e2eMock()
    ? // The fake answers by command name; the cast keeps callers typed.
      (new FakeAwsClient() as unknown as SESv2Client)
    : new SESv2Client({ region: c.region, credentials: c.credentials });
export const makeSns = (c: AwsContext) =>
  e2eMock()
    ? (new FakeAwsClient() as unknown as SNSClient)
    : new SNSClient({ region: c.region, credentials: c.credentials });
export const makeSts = (c: AwsContext) =>
  e2eMock()
    ? (new FakeAwsClient() as unknown as STSClient)
    : new STSClient({ region: c.region, credentials: c.credentials });
