import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { newId } from "@sendsprite/shared";
import { db } from "@/db";
import { teamAssets, type TeamAsset } from "@/db/schema";
import { recordAudit, type RequestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";

/**
 * Images an author uploads, for use in a campaign or template body.
 *
 * Every image in an email is a URL a stranger's mail client fetches with no
 * credentials, so what this stores has to be publicly readable for as long as
 * the mail exists. See `db/schema/assets.ts` for why the bytes live in
 * Postgres rather than in S3 or on disk.
 *
 * ## The type is decided here, not by the uploader
 *
 * `file.type` is whatever the browser guessed from the extension, and on a
 * hand-rolled request it is whatever the caller typed. It is not evidence.
 * {@link sniff} reads the first bytes and returns a type only for the four
 * formats mail clients actually render; anything else is refused, including a
 * file that *claims* to be a PNG.
 *
 * That matters more than it looks. The serving route hands these bytes back
 * with the stored `Content-Type`, from the app's own origin — so a stored HTML
 * or SVG file served as such would be a same-origin script in the dashboard's
 * cookie jar. SVG is deliberately absent from the list for exactly that
 * reason: it is an image format that can contain a `<script>`.
 */

/** Per image. Generous for a banner, far below what a mail client will fetch. */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** What the picker shows, and what a browser file dialog should filter to. */
export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

export interface AssetActor {
  userId: string;
  teamId: string;
  meta?: RequestMeta;
}

/** The row without its bytes — everything a list or a picker needs. */
export interface AssetSummary {
  id: string;
  token: string;
  filename: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: Date;
}

const summarise = (a: TeamAsset): AssetSummary => ({
  id: a.id,
  token: a.token,
  filename: a.filename,
  contentType: a.contentType,
  size: a.size,
  width: a.width,
  height: a.height,
  createdAt: a.createdAt,
});

/** `${APP_URL}/a/<token>` — absolute, because a mail client has no base URL. */
export const assetUrl = (appUrl: string, token: string): string =>
  `${appUrl.replace(/\/+$/, "")}/a/${token}`;

/* ------------------------------------------------------------------ *
 * Sniffing
 * ------------------------------------------------------------------ */

const startsWith = (b: Buffer, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/**
 * The content type, from the bytes, or `null`.
 *
 * Deliberately narrow. Each signature below is the format's own header, and
 * anything that does not match one of them is refused rather than guessed at —
 * the failure mode of guessing is serving an attacker-chosen type from this
 * origin, and there is no upside to a fifth image format worth that.
 */
export function sniff(b: Buffer): AcceptedImageType | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // RIFF....WEBP — the size sits between the two markers, so both are checked.
  if (
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)
  )
    return "image/webp";
  return null;
}

/**
 * Intrinsic pixel size, where it is cheap to read, else `null`.
 *
 * Only used to show "1200 × 600" in the picker and to warn about a banner that
 * will be soft on a retina screen. Nothing depends on it, which is why an
 * unreadable header is `null` rather than a refusal — a valid PNG with an
 * unusual chunk order is still a valid PNG.
 */
export function dimensions(
  b: Buffer,
  type: AcceptedImageType,
): { width: number; height: number } | null {
  try {
    if (type === "image/png" && b.length >= 24)
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (type === "image/gif" && b.length >= 10)
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (type === "image/jpeg") return jpegSize(b);
  } catch {
    // A truncated or unusual header is not worth failing an upload over.
  }
  return null;
}

/** Walks JPEG segments to the first SOF marker, which carries the size. */
function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2; // past SOI
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15, excluding the four that are not frame headers.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    )
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function listAssets(
  teamId: string,
  limit = 60,
): Promise<AssetSummary[]> {
  const rows = await db()
    .select({
      id: teamAssets.id,
      token: teamAssets.token,
      filename: teamAssets.filename,
      contentType: teamAssets.contentType,
      size: teamAssets.size,
      width: teamAssets.width,
      height: teamAssets.height,
      createdAt: teamAssets.createdAt,
    })
    .from(teamAssets)
    .where(eq(teamAssets.teamId, teamId))
    .orderBy(desc(teamAssets.createdAt))
    .limit(limit);
  return rows;
}

/**
 * The bytes, for the public serving route.
 *
 * Keyed on the token alone and **not** scoped to a team, which is the whole
 * point: the reader is a mail client in someone else's inbox with no session
 * at all. The token is the capability.
 */
export async function assetByToken(token: string) {
  const [row] = await db()
    .select({
      bytes: teamAssets.bytes,
      contentType: teamAssets.contentType,
      size: teamAssets.size,
      sha256: teamAssets.sha256,
    })
    .from(teamAssets)
    .where(eq(teamAssets.token, token))
    .limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ *
 * Writes
 * ------------------------------------------------------------------ */

export async function uploadAsset(
  actor: AssetActor,
  input: { filename: string; bytes: Buffer },
): Promise<Result<AssetSummary>> {
  if (input.bytes.length === 0)
    return { ok: false, error: "That file is empty." };
  if (input.bytes.length > MAX_ASSET_BYTES)
    return {
      ok: false,
      error: `Images must be under ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB. That one is ${(input.bytes.length / 1024 / 1024).toFixed(1)} MB.`,
    };
  const contentType = sniff(input.bytes);
  if (!contentType)
    return {
      ok: false,
      error:
        "That is not a PNG, JPEG, GIF or WebP. Those are the four formats mail clients render — SVG is not accepted, because an SVG can carry a script.",
    };

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  // The same file twice is the same asset. An author dragging one logo into
  // three campaigns should not be three copies, and the URL staying the same
  // means the second campaign shares whatever caching the first earned.
  const [existing] = await db()
    .select()
    .from(teamAssets)
    .where(
      and(eq(teamAssets.teamId, actor.teamId), eq(teamAssets.sha256, sha256)),
    )
    .limit(1);
  if (existing) return { ok: true, data: summarise(existing) };

  const size = dimensions(input.bytes, contentType);
  const [row] = await db()
    .insert(teamAssets)
    .values({
      id: newId("ast"),
      teamId: actor.teamId,
      token: randomBytes(24).toString("base64url"),
      // Trimmed and bounded: it is shown in the picker and nothing else, and
      // a filename is one of the few strings a user fully controls.
      filename: input.filename.trim().slice(0, 200) || "image",
      contentType,
      bytes: input.bytes,
      size: input.bytes.length,
      sha256,
      width: size?.width ?? null,
      height: size?.height ?? null,
      createdBy: actor.userId,
    })
    .returning();
  if (!row) return { ok: false, error: "The upload could not be stored." };

  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "assets.upload",
    targetType: "asset",
    targetId: row.id,
    diff: { filename: { to: row.filename }, size: { to: row.size } },
    ...actor.meta,
  });
  return { ok: true, data: summarise(row) };
}

/**
 * Deletes an image.
 *
 * There is no reference check, deliberately, and the copy at the call site
 * says so. A body stores the *URL*, not the asset id, and that URL may also be
 * in a campaign already sent — whose recipients will keep fetching it for
 * years. Nothing this product can query tells you whether an image is still
 * wanted, so it does not pretend to; it warns, and lets the operator decide.
 */
export async function deleteAsset(
  actor: AssetActor,
  id: string,
): Promise<Result> {
  const [row] = await db()
    .delete(teamAssets)
    .where(and(eq(teamAssets.id, id), eq(teamAssets.teamId, actor.teamId)))
    .returning({ filename: teamAssets.filename });
  if (!row) return { ok: false, error: "That image is already gone." };
  await recordAudit({
    teamId: actor.teamId,
    actorUserId: actor.userId,
    action: "assets.delete",
    targetType: "asset",
    targetId: id,
    diff: { filename: { from: row.filename } },
    ...actor.meta,
  });
  return { ok: true, data: undefined };
}
