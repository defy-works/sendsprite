import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

const draft = {
  slug: "welcome",
  name: "Welcome",
  subject: "Hi {{name}}",
  bodyHtml: "<p>Hello {{name}}</p>",
  bodyText: "Hello {{name}}",
};

describe("templates service", () => {
  it("creates at version 1 and records the first version snapshot", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    const created = await svc.createTemplate(actor, draft);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("unreachable");
    expect(created.data.id).toMatch(/^tpl_/);
    expect(created.data.version).toBe(1);
    const versions = await svc.listTemplateVersions(actor.teamId, "welcome");
    expect(versions.map((v) => v.version)).toEqual([1]);
    expect(versions[0]!.snapshot.subject).toBe("Hi {{name}}");
    // The snapshot is what was stored, field for field — history is
    // reconstructible from `template_versions` alone.
    expect(versions[0]!.snapshot).toEqual({
      name: "Welcome",
      subject: "Hi {{name}}",
      bodyHtml: "<p>Hello {{name}}</p>",
      bodyText: "Hello {{name}}",
      variablesSchema: { variables: [] },
    });
  });

  it("refuses a duplicate slug in the same team with `conflict`", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    expect((await svc.createTemplate(actor, draft)).ok).toBe(true);
    const again = await svc.createTemplate(actor, draft);
    expect(again).toMatchObject({ ok: false, code: "conflict" });
    // The failed create left no orphan version row behind.
    const versions = await svc.listTemplateVersions(actor.teamId, "welcome");
    expect(versions).toHaveLength(1);
  });

  it("refuses invalid input without touching the table", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    expect(
      await svc.createTemplate(actor, { ...draft, slug: "Not A Slug" }),
    ).toMatchObject({ ok: false });
    expect(await svc.listTemplates(actor.teamId)).toHaveLength(0);
  });

  it("bumps the version and appends a snapshot only when content changed", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    const same = await svc.updateTemplate(actor, "welcome", {
      name: "Welcome",
    });
    if (!same.ok) throw new Error("unreachable");
    expect(same.data.version).toBe(1); // nothing actually changed
    const changed = await svc.updateTemplate(actor, "welcome", {
      bodyHtml: "<p>Hey {{name}}</p>",
    });
    if (!changed.ok) throw new Error("unreachable");
    expect(changed.data.version).toBe(2);
    const versions = await svc.listTemplateVersions(actor.teamId, "welcome");
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    // Newest first, and the newest snapshot equals the live row.
    expect(versions[0]!.snapshot.bodyHtml).toBe("<p>Hey {{name}}</p>");
    expect(versions[0]!.snapshot).toEqual({
      name: changed.data.name,
      subject: changed.data.subject,
      bodyHtml: changed.data.bodyHtml,
      bodyText: changed.data.bodyText,
      variablesSchema: changed.data.variablesSchema,
    });
  });

  it("treats a re-submitted identical body as a no-op, structurally", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    const created = await svc.createTemplate(actor, {
      ...draft,
      variablesSchema: { variables: [{ name: "name", type: "string" }] },
    });
    if (!created.ok) throw new Error("unreachable");
    // What the dashboard editor and `templates push` both send: the whole
    // object, unchanged. An equal-but-not-identical `variablesSchema` must
    // not count as an edit, or every save click cuts a version.
    const resubmit = await svc.updateTemplate(actor, "welcome", {
      name: draft.name,
      subject: draft.subject,
      bodyHtml: draft.bodyHtml,
      bodyText: draft.bodyText,
      variablesSchema: { variables: [{ name: "name", type: "string" }] },
    });
    if (!resubmit.ok) throw new Error("unreachable");
    expect(resubmit.data.version).toBe(1);
    expect(
      await svc.listTemplateVersions(actor.teamId, "welcome"),
    ).toHaveLength(1);
  });

  it("restores an old version by replaying its snapshot as an update", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    await svc.updateTemplate(actor, "welcome", {
      bodyHtml: "<p>Hey {{name}}</p>",
    });
    const [, v1] = await svc.listTemplateVersions(actor.teamId, "welcome");
    // A snapshot *is* an `UpdateTemplateInput`: a restore is an ordinary
    // edit, and it appends a version of its own rather than rewriting history.
    const restored = await svc.updateTemplate(actor, "welcome", v1!.snapshot);
    if (!restored.ok) throw new Error("unreachable");
    expect(restored.data.version).toBe(3);
    expect(restored.data.bodyHtml).toBe(draft.bodyHtml);
    const versions = await svc.listTemplateVersions(actor.teamId, "welcome");
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions[0]!.snapshot).toEqual(v1!.snapshot);
  });

  it("looks a template up by slug or by id, scoped to the team", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    const created = await svc.createTemplate(actor, draft);
    if (!created.ok) throw new Error("unreachable");
    expect((await svc.getTemplate(actor.teamId, "welcome"))?.id).toBe(
      created.data.id,
    );
    expect((await svc.getTemplate(actor.teamId, created.data.id))?.slug).toBe(
      "welcome",
    );
    // The REST path segment arrives as typed; the slug is stored lower-cased.
    expect((await svc.getTemplate(actor.teamId, " WELCOME "))?.id).toBe(
      created.data.id,
    );
    expect(await svc.getTemplate(actor.teamId, "")).toBeNull();
    const other = await seedTeamWithKey();
    expect(await svc.getTemplate(other.actor.teamId, "welcome")).toBeNull();
    expect(
      await svc.getTemplate(other.actor.teamId, created.data.id),
    ).toBeNull();
    expect(
      await svc.listTemplateVersions(other.actor.teamId, "welcome"),
    ).toEqual([]);
  });

  it("renders a stored template, and refuses one whose variables are missing", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    const ok = await svc.renderStoredTemplate(actor.teamId, "welcome", {
      name: "<Mingu>",
    });
    if (!ok.ok) throw new Error("unreachable");
    expect(ok.data).toEqual({
      subject: "Hi <Mingu>",
      html: "<p>Hello &lt;Mingu&gt;</p>",
      text: "Hello <Mingu>",
    });
    const bad = await svc.renderStoredTemplate(actor.teamId, "welcome", {});
    expect(bad).toMatchObject({ ok: false, code: "validation_error" });
    if (bad.ok) throw new Error("unreachable");
    expect(bad.details).toMatchObject({
      field: "variables",
      missing: ["name"],
    });
    const gone = await svc.renderStoredTemplate(actor.teamId, "nope", {});
    expect(gone).toMatchObject({ ok: false, code: "not_found" });
  });

  it("renders through the stored variables schema, defaults included", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, {
      ...draft,
      variablesSchema: {
        variables: [{ name: "name", type: "string", default: "there" }],
      },
    });
    // The declared default is part of the stored row, so the preview and the
    // send resolve it the same way — neither caller supplies the schema.
    const blank = await svc.renderStoredTemplate(actor.teamId, "welcome", {
      name: "   ",
    });
    if (!blank.ok) throw new Error("unreachable");
    expect(blank.data.subject).toBe("Hi there");
  });

  it("refuses a variables payload that breaks the shared caps", async () => {
    const svc = await import("@/services/templates");
    const { MAX_VARIABLE_VALUE_CHARS } = await import("@sendsprite/shared");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    const huge = await svc.renderStoredTemplate(actor.teamId, "welcome", {
      name: "x".repeat(MAX_VARIABLE_VALUE_CHARS + 1),
    });
    expect(huge).toMatchObject({ ok: false, code: "validation_error" });
    if (huge.ok) throw new Error("unreachable");
    expect(huge.details).toMatchObject({ field: "variables" });
  });

  it("deletes, and reports not_found for an unknown slug", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    expect((await svc.deleteTemplate(actor, "welcome")).ok).toBe(true);
    expect(await svc.getTemplate(actor.teamId, "welcome")).toBeNull();
    expect(await svc.deleteTemplate(actor, "welcome")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("refuses every mutation for a role without templates.manage", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    // No role in the table lacks `templates.manage`, so this pins the gate
    // itself rather than a role: an actor with an unknown role is refused.
    const outsider = { ...actor, role: "viewer" as never };
    expect(await svc.createTemplate(outsider, draft)).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    await svc.createTemplate(actor, draft);
    expect(
      await svc.updateTemplate(outsider, "welcome", { name: "x" }),
    ).toMatchObject({ ok: false, code: "forbidden" });
    expect(await svc.deleteTemplate(outsider, "welcome")).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    // The gate runs before the lookup, so a forbidden actor cannot probe
    // which slugs exist.
    expect(await svc.deleteTemplate(outsider, "no-such-slug")).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect((await svc.getTemplate(actor.teamId, "welcome"))?.version).toBe(1);
  });

  it("writes an audit row for create, update and delete", async () => {
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq, like } = await import("drizzle-orm");
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    await svc.updateTemplate(actor, "welcome", { name: "Welcome!" });
    await svc.deleteTemplate(actor, "welcome");
    const rows = await db()
      .select({
        action: auditLog.action,
        targetId: auditLog.targetId,
        diff: auditLog.diff,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.teamId, actor.teamId),
          like(auditLog.action, "templates.%"),
        ),
      );
    expect(rows.map((r) => r.action).sort()).toEqual([
      "templates.create",
      "templates.delete",
      "templates.update",
    ]);
    expect(rows.every((r) => r.targetId === "welcome")).toBe(true);
    const update = rows.find((r) => r.action === "templates.update");
    // Which fields moved and to what version — never the bodies, which are
    // megabytes and are already in `template_versions`.
    expect(update?.diff).toEqual({
      fields: { to: "name" },
      version: { from: 1, to: 2 },
    });
  });

  it("writes no audit row and cuts no version for a no-op update", async () => {
    const { db } = await import("@/db");
    const { auditLog } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    await svc.createTemplate(actor, draft);
    await svc.updateTemplate(actor, "welcome", { name: draft.name });
    const rows = await db()
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.teamId, actor.teamId),
          eq(auditLog.action, "templates.update"),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("pages the list newest first", async () => {
    const svc = await import("@/services/templates");
    const { actor } = await seedTeamWithKey();
    for (const slug of ["a", "b", "c"])
      await svc.createTemplate(actor, { ...draft, slug });
    const page = await svc.listTemplatesPage(actor.teamId, { limit: 2 });
    if (!page.ok) throw new Error("unreachable");
    expect(page.data.data).toHaveLength(2);
    expect(page.data.nextCursor).not.toBeNull();
    const rest = await svc.listTemplatesPage(actor.teamId, {
      limit: 2,
      cursor: page.data.nextCursor!,
    });
    if (!rest.ok) throw new Error("unreachable");
    expect(rest.data.data).toHaveLength(1);
    expect(rest.data.nextCursor).toBeNull();
    // Newest first across both pages, and scoped to the team.
    expect([...page.data.data, ...rest.data.data].map((t) => t.slug)).toEqual([
      "c",
      "b",
      "a",
    ]);
    const other = await seedTeamWithKey();
    const empty = await svc.listTemplatesPage(other.actor.teamId, { limit: 2 });
    if (!empty.ok) throw new Error("unreachable");
    expect(empty.data.data).toEqual([]);
  });

  it("exposes a REST view with no team id on it", async () => {
    const svc = await import("@/services/templates");
    const { TemplateObject, TemplateVersionObject } =
      await import("@sendsprite/shared");
    const { actor } = await seedTeamWithKey();
    const created = await svc.createTemplate(actor, draft);
    if (!created.ok) throw new Error("unreachable");
    const view = svc.publicTemplate(created.data);
    expect(view).not.toHaveProperty("teamId");
    // Dates serialise the way every other route emits them.
    expect(
      TemplateObject.safeParse(JSON.parse(JSON.stringify(view))).success,
    ).toBe(true);
    const [v] = await svc.listTemplateVersions(actor.teamId, "welcome");
    const versionView = svc.publicTemplateVersion(v!);
    expect(versionView).not.toHaveProperty("templateId");
    expect(
      TemplateVersionObject.safeParse(JSON.parse(JSON.stringify(versionView)))
        .success,
    ).toBe(true);
  });
});
