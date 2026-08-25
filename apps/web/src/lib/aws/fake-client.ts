/**
 * In-process stand-in for the SES/SNS/STS clients, used by the Playwright
 * suite (a real Next server, no AWS). Activated only via `makeSes` & co. in
 * `clients.ts` when `AWS_E2E_MOCK=1` outside production. Canned responses
 * cover the wizard's manual-keys path and domain provisioning; anything else
 * throws so an unexpected call fails loudly instead of returning `{}`.
 *
 * Typed loosely on purpose: the factory casts it to the SDK client type at
 * the boundary, and the SDK's `send` overloads are far more specific than a
 * name switch can honour.
 */
const ACCOUNT_ID = "111111111111";
const TOPIC_ARN = `arn:aws:sns:us-east-1:${ACCOUNT_ID}:sendsprite-events`;
const DKIM_TOKENS = ["e1", "e2", "e3"];

export class FakeAwsClient {
  async send(cmd: object): Promise<unknown> {
    const name = cmd.constructor.name;
    switch (name) {
      case "GetCallerIdentityCommand":
        return { Account: ACCOUNT_ID };
      case "GetAccountCommand":
        return {
          ProductionAccessEnabled: false,
          SendQuota: { Max24HourSend: 200, MaxSendRate: 1 },
        };
      case "CreateTopicCommand":
        return { TopicArn: TOPIC_ARN };
      case "SubscribeCommand":
        return { SubscriptionArn: `${TOPIC_ARN}:sub` };
      case "CreateEmailIdentityCommand":
        return { DkimAttributes: { Tokens: DKIM_TOKENS, Status: "PENDING" } };
      case "GetEmailIdentityCommand":
        return {
          DkimAttributes: { Status: "PENDING", Tokens: DKIM_TOKENS },
          MailFromAttributes: { MailFromDomainStatus: "PENDING" },
        };
      case "CreateConfigurationSetCommand":
      case "CreateConfigurationSetEventDestinationCommand":
      case "UnsubscribeCommand":
      case "PutAccountDetailsCommand":
      case "PutEmailIdentityMailFromAttributesCommand":
      case "DeleteEmailIdentityCommand":
        return {};
      default:
        throw new Error(`FakeAwsClient: unhandled ${name}`);
    }
  }
  destroy() {}
}
