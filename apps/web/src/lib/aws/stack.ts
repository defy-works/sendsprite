/**
 * The CloudFormation stack behind a one-click connection. A stack ARN is
 * `arn:aws:cloudformation:<region>:<account>:stack/<name>/<uuid>`; the name
 * is what a person recognises, the whole ARN is what the console wants.
 */
export interface StackRef {
  region: string;
  accountId: string;
  name: string;
}

const STACK_ARN =
  /^arn:aws:cloudformation:([a-z0-9-]+):(\d{12}):stack\/([^/]+)\/[0-9a-f-]+$/;

/** Null for anything that is not a well-formed stack ARN. */
export function parseStackArn(arn: string): StackRef | null {
  const m = STACK_ARN.exec(arn);
  return m ? { region: m[1]!, accountId: m[2]!, name: m[3]! } : null;
}

/**
 * The stack's page in the CloudFormation console — the events tab, since a
 * deletion in progress is what the owner will be looking for.
 */
export function stackConsoleUrl(arn: string): string | null {
  const ref = parseStackArn(arn);
  if (!ref) return null;
  return `https://${ref.region}.console.aws.amazon.com/cloudformation/home?region=${ref.region}#/stacks/events?stackId=${encodeURIComponent(arn)}`;
}
