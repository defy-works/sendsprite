/**
 * Accepted S3 template URLs (https only, host anchored at `amazonaws.com/`):
 *  - virtual-hosted regional: `https://bucket.s3.<region>.amazonaws.com/key`
 *  - virtual-hosted global:   `https://bucket.s3.amazonaws.com/key`
 *  - path-style regional:     `https://s3.<region>.amazonaws.com/bucket/key`
 * Not accepted: legacy global path-style (`https://s3.amazonaws.com/bucket/key`),
 * dualstack (`s3.dualstack.<region>`), and anything that merely contains
 * `s3.amazonaws.com` in the path or as a subdomain of another host.
 * Shared with the `CFN_TEMPLATE_URL` env check.
 */
const S3_URL =
  /^https:\/\/(([a-z0-9.-]+\.)?s3[.-][a-z0-9-]+|[a-z0-9.-]+\.s3)\.amazonaws\.com\//;

export const isS3TemplateUrl = (url: string): boolean => S3_URL.test(url);

export interface QuickCreateInput {
  region: string;
  templateUrl: string;
  callbackUrl: string;
  callbackToken: string;
  stackName: string;
}

/**
 * CloudFormation quick-create link. AWS only accepts S3 template URLs here,
 * which is why the template is published to a bucket rather than served by
 * the instance. Parameters map to `param_<Name>` and must match the template.
 */
export function buildQuickCreateUrl(i: QuickCreateInput): string {
  if (!isS3TemplateUrl(i.templateUrl))
    throw new Error(
      "templateUrl must be an S3 URL (CloudFormation quick-create only accepts S3)",
    );
  const q = new URLSearchParams({
    templateURL: i.templateUrl,
    stackName: i.stackName,
    param_CallbackUrl: i.callbackUrl,
    param_CallbackToken: i.callbackToken,
  });
  return `https://${i.region}.console.aws.amazon.com/cloudformation/home?region=${i.region}#/stacks/create/review?${q.toString()}`;
}
