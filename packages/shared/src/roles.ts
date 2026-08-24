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
];
const OWNER: readonly Action[] = [...ADMIN, "team.delete", "instance.manage"];

const TABLE: Record<TeamRole, ReadonlySet<Action>> = {
  owner: new Set(OWNER),
  admin: new Set(ADMIN),
  member: new Set(MEMBER),
};

export function can(role: TeamRole, action: Action): boolean {
  return TABLE[role].has(action);
}
