import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  can,
  TEAM_ROLES,
  type Action,
  type TeamRole,
} from "../src/roles";

describe("roles", () => {
  it("lists owner, admin, member in that order", () => {
    expect(TEAM_ROLES).toEqual(["owner", "admin", "member"]);
  });
  it.each<[TeamRole, Action, boolean]>([
    ["owner", "team.delete", true],
    ["admin", "team.delete", false],
    ["admin", "members.invite", true],
    ["member", "members.invite", false],
    ["member", "emails.send", true],
    ["member", "apiKeys.create", false],
    ["admin", "instance.manage", false],
    ["owner", "instance.manage", true],
  ])("%s can %s → %s", (role, action, expected) => {
    expect(can(role, action)).toBe(expected);
  });
  it("owner can do every action", () => {
    expect(ACTIONS.every((a) => can("owner", a))).toBe(true);
  });
  it("permissions are a strict hierarchy: member ⊆ admin ⊆ owner", () => {
    for (const a of ACTIONS) {
      if (can("member", a)) expect(can("admin", a)).toBe(true);
      if (can("admin", a)) expect(can("owner", a)).toBe(true);
    }
  });
});
