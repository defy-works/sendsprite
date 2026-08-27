export const TEAM_ROLES = ["owner", "admin", "member"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export const ACTIONS = [
  "team.rename",
  "team.delete",
  "members.invite",
  "members.remove",
  "members.changeRole",
  "domains.manage",
  "apiKeys.create",
  "apiKeys.revoke",
  "webhooks.manage",
  "emails.send",
  "emails.read",
  "contacts.manage",
  "campaigns.manage",
  "templates.manage",
  "settings.manage",
  "billing.manage",
  "instance.manage",
] as const;
export type Action = (typeof ACTIONS)[number];

const MEMBER: readonly Action[] = [
  "emails.send",
  "emails.read",
  "templates.manage",
  "contacts.manage",
];
const ADMIN: readonly Action[] = [
  ...MEMBER,
  "team.rename",
  "members.invite",
  "members.remove",
  "members.changeRole",
  "domains.manage",
  "apiKeys.create",
  "apiKeys.revoke",
  "webhooks.manage",
  "campaigns.manage",
  "settings.manage",
  "billing.manage",
];
const OWNER: readonly Action[] = [...ADMIN, "team.delete", "instance.manage"];

const TABLE: Record<TeamRole, ReadonlySet<Action>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  member: new Set(MEMBER),
};

/**
 * Fail-closed on an unknown role. `role` is typed, but it originates in a
 * `text` column: a membership row written by an older build, by better-auth's
 * own defaults or by hand reaches here as a string the table has no entry for.
 * Indexing blindly turns that into a `TypeError` thrown out of a service whose
 * contract is a `Result` — a 500 where the honest answer is "not permitted".
 */
export function can(role: TeamRole, action: Action): boolean {
  return TABLE[role]?.has(action) ?? false;
}
