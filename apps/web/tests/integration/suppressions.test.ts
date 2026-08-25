import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPg } from "./_pg";

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
  process.env.APP_SECRET = "x".repeat(40);
  await pg.db.execute(
    `insert into "organization"(id,name,slug,created_at) values ('org_1','Acme','acme',now())`,
  );
});
afterAll(async () => {
  await pg.stop();
});

const actor = {
  userId: "u1",
  teamId: "org_1",
  teamName: "Acme",
  role: "admin" as const,
};

describe("suppressions", () => {
  it("adds (idempotent), checks, lists, removes", async () => {
    const {
      addSuppression,
      isSuppressed,
      listSuppressions,
      removeSuppression,
      suppressFromEvent,
    } = await import("@/services/suppressions");
    expect(
      (
        await addSuppression(actor, {
          email: "Bad@X.io",
          reason: "manual",
          note: "asked",
        })
      ).ok,
    ).toBe(true);
    expect(
      (await addSuppression(actor, { email: "bad@x.io", reason: "manual" })).ok,
    ).toBe(true); // idempotent
    expect(await isSuppressed("org_1", ["ok@x.io", "BAD@x.io"])).toEqual([
      { email: "bad@x.io", reason: "manual" },
    ]);
    expect(await isSuppressed("org_1", [])).toEqual([]);
    await suppressFromEvent(
      "org_1",
      [{ email: "B2@x.io", reason: "bounce" }],
      "em_1",
    );
    // Idempotent: a repeated event never throws on the unique index.
    await suppressFromEvent(
      "org_1",
      [{ email: "b2@x.io", reason: "complaint" }],
      "em_2",
    );
    const list = await listSuppressions("org_1");
    expect(list.map((s) => s.email).sort()).toEqual(["b2@x.io", "bad@x.io"]);
    expect(list.find((s) => s.email === "b2@x.io")).toMatchObject({
      reason: "bounce",
      sourceEmailId: "em_1",
    });
    expect((await removeSuppression(actor, "BAD@x.io")).ok).toBe(true);
    expect((await removeSuppression(actor, "bad@x.io")).ok).toBe(false);
    expect(
      (await removeSuppression({ ...actor, role: "member" }, "b2@x.io")).ok,
    ).toBe(false);
    // Any member may suppress; only admins may un-suppress (see service).
    expect(
      (await addSuppression({ ...actor, role: "member" }, { email: "m@x.io" }))
        .ok,
    ).toBe(true);
    expect((await addSuppression(actor, { email: "not-an-email" })).ok).toBe(
      false,
    );
    // Bounce/complaint come only from SES events, never from an actor.
    expect(
      (await addSuppression(actor, { email: "x@x.io", reason: "bounce" })).ok,
    ).toBe(false);
    expect(
      await removeSuppression({ ...actor, role: "member" }, "b2@x.io"),
    ).toMatchObject({ ok: false, code: "forbidden" });
  });
});
