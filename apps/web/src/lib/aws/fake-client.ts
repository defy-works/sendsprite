/**
 * In-process stand-in for the SES/SNS/STS clients, used by the Playwright
 * suite (a real Next server, no AWS). Activated only via `makeSes` & co. in
 * `clients.ts` when `AWS_E2E_MOCK=1` outside production. Canned responses
 * cover the wizard's manual-keys path and domain provisioning; anything else
 * throws so an unexpected call fails loudly instead of returning `{}`.
 *
 * `AWS_E2E_VERIFY=1` makes `GetEmailIdentity` report DKIM and MAIL FROM as
 * SUCCESS so an inline Re-verify flips a domain to `verified` at once, and
 * `SendEmail` answers with a unique `fake-<nonce>-<n>` message id — both for
 * the send e2e spec.
 *
 * Typed loosely on purpose: the factory casts it to the SDK client type at
 * the boundary, and the SDK's `send` overloads are far more specific than a
 * name switch can honour.
 */
const ACCOUNT_ID = "111111111111";
/**
 * Derived from the requested topic name, exactly as SNS does. A constant ARN
 * here would let only one team ever connect: topic names carry the org slug
 * and `team_aws.sns_topic_arn` is unique, so a second team's connect would
 * die on the constraint rather than on anything it did.
 */
const topicArn = (name: string) =>
  `arn:aws:sns:us-east-1:${ACCOUNT_ID}:${name}`;
const DKIM_TOKENS = ["e1", "e2", "e3"];
// `emails.ses_message_id` is unique and the dev database persists between
// runs, so ids carry a per-boot nonce in addition to the counter.
const SEND_NONCE = Date.now().toString(36);
let sendCounter = 0;

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
      case "CreateTopicCommand": {
        const input = (cmd as { input?: { Name?: string } }).input;
        return { TopicArn: topicArn(input?.Name ?? "sendsprite-events") };
      }
      case "SubscribeCommand": {
        const input = (cmd as { input?: { TopicArn?: string } }).input;
        return { SubscriptionArn: `${input?.TopicArn ?? ""}:sub` };
      }
      case "CreateEmailIdentityCommand":
        return { DkimAttributes: { Tokens: DKIM_TOKENS, Status: "PENDING" } };
      case "GetEmailIdentityCommand": {
        const status =
          process.env.AWS_E2E_VERIFY === "1" ? "SUCCESS" : "PENDING";
        return {
          DkimAttributes: { Status: status, Tokens: DKIM_TOKENS },
          MailFromAttributes: { MailFromDomainStatus: status },
        };
      }
      case "SendEmailCommand":
        sendCounter += 1;
        return { MessageId: `fake-${SEND_NONCE}-${sendCounter}` };
      case "CreateConfigurationSetCommand":
      case "CreateConfigurationSetEventDestinationCommand":
      case "UnsubscribeCommand":
      case "PutAccountDetailsCommand":
      case "PutEmailIdentityMailFromAttributesCommand":
      case "DeleteEmailIdentityCommand":
      case "DeleteStackCommand":
        return {};
      default:
        throw new Error(`FakeAwsClient: unhandled ${name}`);
    }
  }
  destroy() {}
}
