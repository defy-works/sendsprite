import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CampaignBlock } from "@sendsprite/shared";
import { startPg } from "./_pg";
import { seedTeamWithKey } from "./helpers";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

const BLOCKS: CampaignBlock[] = [
  { kind: "divider" },
  { kind: "text", html: "Your Company, 1 Example Street" },
];

const who = (a: { userId: string; teamId: string }) => ({
  userId: a.userId,
  teamId: a.teamId,
});

describe("saved layouts", () => {
  it("saves and lists a layout, alphabetically", async () => {
    const svc = await import("@/services/layouts");
    const { actor } = await seedTeamWithKey();
    for (const name of ["Zed", "Alpha"])
      expect(
        (await svc.saveLayout(who(actor), { name, blocks: BLOCKS })).ok,
      ).toBe(true);
    expect((await svc.listLayouts(actor.teamId)).map((l) => l.name)).toEqual([
      "Alpha",
      "Zed",
    ]);
  });

  /**
   * The check that earns its keep: a layout is inserted into a body without
   * further validation, so a layout holding an invalid block would produce a
   * body that fails to render — and the author would meet that failure in a
   * campaign they did not write the broken part of.
   */
  it("refuses blocks the contract would refuse", async () => {
    const svc = await import("@/services/layouts");
    const { actor } = await seedTeamWithKey();
    const bad = await svc.saveLayout(who(actor), {
      name: "Evil",
      blocks: [{ kind: "button", label: "Go", url: "javascript:alert(1)" }],
    });
    expect(bad.ok).toBe(false);
  });

  it("refuses an empty layout and an empty name", async () => {
    const svc = await import("@/services/layouts");
    const { actor } = await seedTeamWithKey();
    expect(
      (await svc.saveLayout(who(actor), { name: "X", blocks: [] })).ok,
    ).toBe(false);
    expect(
      (await svc.saveLayout(who(actor), { name: "   ", blocks: BLOCKS })).ok,
    ).toBe(false);
  });

  it("reports a duplicate name rather than overwriting it", async () => {
    const svc = await import("@/services/layouts");
    const { actor } = await seedTeamWithKey();
    expect(
      (await svc.saveLayout(who(actor), { name: "Footer", blocks: BLOCKS })).ok,
    ).toBe(true);
    const again = await svc.saveLayout(who(actor), {
      name: "Footer",
      blocks: BLOCKS,
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error).toContain("already has a layout");
  });

  it("keeps two teams' layouts apart, name and all", async () => {
    const svc = await import("@/services/layouts");
    const one = await seedTeamWithKey();
    const two = await seedTeamWithKey();
    for (const t of [one, two])
      expect(
        (await svc.saveLayout(who(t.actor), { name: "Footer", blocks: BLOCKS }))
          .ok,
      ).toBe(true);
    expect(await svc.listLayouts(one.actor.teamId)).toHaveLength(1);
    expect(await svc.listLayouts(two.actor.teamId)).toHaveLength(1);
  });

  it("stores a theme when given one and null when not", async () => {
    const svc = await import("@/services/layouts");
    const { actor } = await seedTeamWithKey();
    const withTheme = await svc.saveLayout(who(actor), {
      name: "Dark",
      blocks: BLOCKS,
      theme: { pageBackground: "#0b1020", cardBackground: "#111827" },
    });
    if (!withTheme.ok) throw new Error(withTheme.error);
    expect(withTheme.data.theme).toEqual({
      pageBackground: "#0b1020",
      cardBackground: "#111827",
    });
    const plain = await svc.saveLayout(who(actor), {
      name: "Plain",
      blocks: BLOCKS,
    });
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.data.theme).toBeNull();
  });

  it("refuses a theme the contract would refuse", async () => {
    const svc = await import("@/services/layouts");
    const { actor } = await seedTeamWithKey();
    const bad = await svc.saveLayout(who(actor), {
      name: "Bad",
      blocks: BLOCKS,
      theme: { pageBackground: "rebeccapurple" },
    });
    expect(bad.ok).toBe(false);
  });

  it("deletes only within the owning team", async () => {
    const svc = await import("@/services/layouts");
    const mine = await seedTeamWithKey();
    const theirs = await seedTeamWithKey();
    const saved = await svc.saveLayout(who(mine.actor), {
      name: "Footer",
      blocks: BLOCKS,
    });
    if (!saved.ok) throw new Error(saved.error);
    expect((await svc.deleteLayout(who(theirs.actor), saved.data.id)).ok).toBe(
      false,
    );
    expect(await svc.listLayouts(mine.actor.teamId)).toHaveLength(1);
    expect((await svc.deleteLayout(who(mine.actor), saved.data.id)).ok).toBe(
      true,
    );
    expect(await svc.listLayouts(mine.actor.teamId)).toHaveLength(0);
  });

  it("caps how many a team may keep", async () => {
    const svc = await import("@/services/layouts");
    const { actor } = await seedTeamWithKey();
    for (let i = 0; i < svc.MAX_LAYOUTS; i++)
      expect(
        (await svc.saveLayout(who(actor), { name: `L${i}`, blocks: BLOCKS }))
          .ok,
      ).toBe(true);
    const over = await svc.saveLayout(who(actor), {
      name: "One too many",
      blocks: BLOCKS,
    });
    expect(over.ok).toBe(false);
  });
});

describe("the built-in presets", () => {
  /**
   * They are values in the bundle rather than rows, so nothing validates them
   * at runtime — which makes this the only thing that does. A preset that does
   * not parse is a body that will not render, shipped in the build.
   */
  it("every one parses as a campaign body", async () => {
    const { LAYOUT_PRESETS } = await import("@/lib/editor/layouts");
    const { CampaignBlock: Block } = await import("@sendsprite/shared");
    expect(LAYOUT_PRESETS.length).toBeGreaterThan(0);
    for (const preset of LAYOUT_PRESETS) {
      expect(preset.blocks.length).toBeGreaterThan(0);
      for (const b of preset.blocks) {
        const parsed = Block.safeParse(b);
        if (!parsed.success)
          throw new Error(
            `${preset.id}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
          );
      }
    }
  });

  it("every one renders", async () => {
    const { LAYOUT_PRESETS } = await import("@/lib/editor/layouts");
    const { renderBlocks } = await import("@sendsprite/shared");
    for (const preset of LAYOUT_PRESETS)
      expect(renderBlocks(preset.blocks).html).toContain("<table");
  });

  it("has unique ids", async () => {
    const { LAYOUT_PRESETS } = await import("@/lib/editor/layouts");
    const ids = LAYOUT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
