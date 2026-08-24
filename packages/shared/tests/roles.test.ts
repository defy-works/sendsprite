import { describe, expect, it } from "vitest";
import { can, TEAM_ROLES, type TeamRole } from "../src/roles";

describe("roles", () => {
  it("lists owner, admin, member in that order", () => {
    expect(TEAM_ROLES).toEqual(["owner", "admin", "member"]);
  });
  it.each<[TeamRole, string, boolean]>([
    ["owner", "team.delete", true],
    ["admin", "team.delete", false],
    ["admin", "members.invite", true],
    ["member", "members.invite", false],
    ["member", "emails.send", true],
    ["member", "apiKeys.create", false],
    ["admin", "instance.manage", false],
    ["owner", "instance.manage", true],
  ])("%s can %s → %s", (role, action, expected) => {
    expect(can(role, action as never)).toBe(expected);
  });
});
