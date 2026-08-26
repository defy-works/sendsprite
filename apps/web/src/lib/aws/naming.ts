/**
 * AWS resource names for one team.
 *
 * Nothing stops one person connecting two orgs to the **same** AWS account,
 * so these names cannot be constants. A shared configuration set is the
 * dangerous case: `CreateConfigurationSetEventDestination` takes its
 * `AlreadyExists` branch and *updates* the destination, silently repointing
 * one org's SES events at another org's SNS topic. Sharing a topic is the
 * milder failure — `CreateTopic` is idempotent by name, so the second team's
 * connect dies on the `sns_topic_arn` unique constraint.
 *
 * The three services disagree on legal characters (CloudFormation stack
 * names are `[A-Za-z][A-Za-z0-9-]*`; SES configuration sets and SNS topics
 * also allow `_`), so one sanitiser governs all three and the strictest rule
 * wins. 40 characters leaves room under every limit once the prefixes are
 * added.
 *
 * Names are chosen once at connect time and persisted on `team_aws`. Slugs
 * are mutable — never re-derive a name for an existing connection or it will
 * address a configuration set that does not exist.
 */
const MAX = 40;

export function awsResourceSuffix(slug: string): string {
  const s = slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX)
    // Again after the slice: the cap can land on a hyphen, and a trailing
    // hyphen is illegal in all three services.
    .replace(/-$/, "");
  return s.length > 0 ? s : "team";
}

export const stackName = (slug: string) =>
  `sendsprite-connect-${awsResourceSuffix(slug)}`;
export const configSetName = (slug: string) =>
  `sendsprite-${awsResourceSuffix(slug)}`;
export const topicName = (slug: string) =>
  `sendsprite-events-${awsResourceSuffix(slug)}`;
