/**
 * Opaque keyset cursor for lists ordered by `(created_at desc, id desc)`:
 * base64url of `<createdAt ISO>|<id>`. Carrying both columns means the next
 * page needs no lookup of the cursor row, so a row deleted mid-walk does not
 * restart the client from page one.
 */
export const encodeCursor = (r: { createdAt: Date; id: string }) =>
  Buffer.from(`${r.createdAt.toISOString()}|${r.id}`).toString("base64url");

/** Null when malformed; the caller decides whether that is a 400 or page one. */
export function decodeCursor(
  c: string,
): { createdAt: Date; id: string } | null {
  const s = Buffer.from(c, "base64url").toString();
  const i = s.indexOf("|");
  if (i <= 0) return null;
  const createdAt = new Date(s.slice(0, i));
  const id = s.slice(i + 1);
  return Number.isNaN(createdAt.getTime()) || !id ? null : { createdAt, id };
}
