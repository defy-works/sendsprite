import MessageValidator from "sns-validator";

export type SnsMessage =
  | {
      Type: "SubscriptionConfirmation";
      TopicArn: string;
      Token: string;
      SubscribeURL: string;
      MessageId: string;
    }
  | {
      Type: "Notification";
      TopicArn: string;
      Message: string;
      MessageId: string;
      Timestamp: string;
    }
  | { Type: "UnsubscribeConfirmation"; TopicArn: string; MessageId: string };

const validator = new MessageValidator(
  /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/,
);

/** Verifies the SNS signature (cert fetched from amazonaws.com only). Throws on failure. */
export function verifySnsMessage(raw: unknown): Promise<SnsMessage> {
  return new Promise((resolve, reject) => {
    validator.validate(raw, (err, msg) =>
      err ? reject(err) : resolve(msg as SnsMessage),
    );
  });
}
