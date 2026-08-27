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

/** A one-pixel PNG, header-accurate — the sniffer reads the first eight bytes. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  // APP0 length 16, JFIF, then an SOF0 declaring 40 × 30.
  Buffer.from([0x00, 0x10]),
  Buffer.alloc(14),
  Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x00, 0x28]),
  Buffer.alloc(8),
]);
const GIF = Buffer.concat([
  Buffer.from("GIF89a", "ascii"),
  // Logical screen: 3 × 5, little-endian.
  Buffer.from([0x03, 0x00, 0x05, 0x00]),
  Buffer.alloc(10),
]);

describe("asset uploads", () => {
  it("decides the type from the bytes, not from the filename", async () => {
    const svc = await import("@/services/assets");
    const { actor } = await seedTeamWithKey();
    const a = { userId: actor.userId, teamId: actor.teamId };
    // Named `.jpg`, and it is a PNG. The name is not evidence.
    const res = await svc.uploadAsset(a, {
      filename: "logo.jpg",
      bytes: PNG,
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.contentType).toBe("image/png");
    expect(res.data.filename).toBe("logo.jpg");
  });

  /**
   * The upload rule that matters most. These bytes are served back from the
   * app's own origin with the stored content type, so anything a browser will
   * treat as active content here runs in the dashboard's cookie jar — and an
   * SVG is an image format that can contain a `<script>`.
   */
  it("refuses an SVG, and refuses HTML wearing a PNG name", async () => {
    const svc = await import("@/services/assets");
    const { actor } = await seedTeamWithKey();
    const a = { userId: actor.userId, teamId: actor.teamId };
    for (const [filename, body] of [
      ["x.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'],
      ["x.png", "<html><script>alert(1)</script></html>"],
      ["x.png", "not an image at all"],
    ] as const) {
      const res = await svc.uploadAsset(a, {
        filename,
        bytes: Buffer.from(body, "utf8"),
      });
      expect(res.ok).toBe(false);
    }
  });

  it("refuses an empty file and one over the cap", async () => {
    const svc = await import("@/services/assets");
    const { actor } = await seedTeamWithKey();
    const a = { userId: actor.userId, teamId: actor.teamId };
    expect(
      (await svc.uploadAsset(a, { filename: "e.png", bytes: Buffer.alloc(0) }))
        .ok,
    ).toBe(false);
    const huge = Buffer.concat([PNG, Buffer.alloc(svc.MAX_ASSET_BYTES)]);
    expect(
      (await svc.uploadAsset(a, { filename: "big.png", bytes: huge })).ok,
    ).toBe(false);
  });

  it("reads the pixel size out of each format it can", async () => {
    const svc = await import("@/services/assets");
    expect(svc.dimensions(PNG, "image/png")).toEqual({ width: 1, height: 1 });
    expect(svc.dimensions(JPEG, "image/jpeg")).toEqual({
      width: 40,
      height: 30,
    });
    expect(svc.dimensions(GIF, "image/gif")).toEqual({ width: 3, height: 5 });
  });

  /**
   * The same file twice is the same asset — an author drags one logo into
   * three campaigns, and three copies of it would be three cache misses as
   * well as three rows.
   */
  it("returns the existing row for identical bytes", async () => {
    const svc = await import("@/services/assets");
    const { actor } = await seedTeamWithKey();
    const a = { userId: actor.userId, teamId: actor.teamId };
    const first = await svc.uploadAsset(a, { filename: "a.png", bytes: PNG });
    const again = await svc.uploadAsset(a, { filename: "b.png", bytes: PNG });
    if (!first.ok || !again.ok) throw new Error("upload failed");
    expect(again.data.id).toBe(first.data.id);
    expect(await svc.listAssets(actor.teamId)).toHaveLength(1);
  });

  /**
   * Dedupe is per team on purpose: two tenants uploading the same stock photo
   * must get a row each, or deleting one breaks the other's mail.
   */
  it("does not share an asset between two teams", async () => {
    const svc = await import("@/services/assets");
    const one = await seedTeamWithKey();
    const two = await seedTeamWithKey();
    const a = await svc.uploadAsset(
      { userId: one.actor.userId, teamId: one.actor.teamId },
      { filename: "shared.png", bytes: PNG },
    );
    const b = await svc.uploadAsset(
      { userId: two.actor.userId, teamId: two.actor.teamId },
      { filename: "shared.png", bytes: PNG },
    );
    if (!a.ok || !b.ok) throw new Error("upload failed");
    expect(a.data.id).not.toBe(b.data.id);
    expect(a.data.token).not.toBe(b.data.token);
  });

  it("serves by token, with no team scope at all", async () => {
    const svc = await import("@/services/assets");
    const { actor } = await seedTeamWithKey();
    const res = await svc.uploadAsset(
      { userId: actor.userId, teamId: actor.teamId },
      { filename: "a.png", bytes: PNG },
    );
    if (!res.ok) throw new Error(res.error);
    // A mail client has no session; the token is the capability.
    const served = await svc.assetByToken(res.data.token);
    expect(served?.contentType).toBe("image/png");
    expect(Buffer.from(served!.bytes).equals(PNG)).toBe(true);
    expect(await svc.assetByToken("nope")).toBeNull();
  });

  it("mints a token long enough not to be guessed", async () => {
    const svc = await import("@/services/assets");
    const { actor } = await seedTeamWithKey();
    const res = await svc.uploadAsset(
      { userId: actor.userId, teamId: actor.teamId },
      { filename: "a.png", bytes: PNG },
    );
    if (!res.ok) throw new Error(res.error);
    // 24 bytes, base64url — the row id is a ULID and would be enumerable from
    // a neighbour, which is why it is not what the URL carries.
    expect(res.data.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("deletes only within the owning team", async () => {
    const svc = await import("@/services/assets");
    const mine = await seedTeamWithKey();
    const theirs = await seedTeamWithKey();
    const res = await svc.uploadAsset(
      { userId: mine.actor.userId, teamId: mine.actor.teamId },
      { filename: "a.png", bytes: PNG },
    );
    if (!res.ok) throw new Error(res.error);
    const crossTenant = await svc.deleteAsset(
      { userId: theirs.actor.userId, teamId: theirs.actor.teamId },
      res.data.id,
    );
    expect(crossTenant.ok).toBe(false);
    expect(await svc.assetByToken(res.data.token)).not.toBeNull();

    const own = await svc.deleteAsset(
      { userId: mine.actor.userId, teamId: mine.actor.teamId },
      res.data.id,
    );
    expect(own.ok).toBe(true);
    expect(await svc.assetByToken(res.data.token)).toBeNull();
  });

  it("builds an absolute URL, with no double slash", async () => {
    const { assetUrl } = await import("@/services/assets");
    expect(assetUrl("https://mail.test", "abc")).toBe(
      "https://mail.test/a/abc",
    );
    expect(assetUrl("https://mail.test/", "abc")).toBe(
      "https://mail.test/a/abc",
    );
  });
});
