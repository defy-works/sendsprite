import { assetByToken } from "@/services/assets";

export const dynamic = "force-dynamic";

/**
 * Serves an uploaded image, to anyone who has the URL.
 *
 * Unauthenticated on purpose and unavoidably: the reader is a mail client in
 * somebody else's inbox, on somebody else's network, with no cookie and no
 * chance to acquire one. The token in the path is the capability — 24 random
 * bytes, and the only thing in the URL (see `db/schema/assets.ts` for why the
 * row id is not).
 *
 * ## The headers are the security boundary
 *
 * These bytes are user-uploaded and served from the app's **own origin**, so
 * anything the browser is willing to treat as active content here runs in the
 * dashboard's cookie jar. Three things stop that, and all three are needed:
 *
 * - `sniff()` decided the type from the file's own header, so this can only
 *   ever be one of four raster image types. SVG is refused at upload.
 * - `X-Content-Type-Options: nosniff` stops the browser second-guessing that
 *   and re-interpreting a crafted file as HTML.
 * - `Content-Security-Policy: sandbox` puts a direct navigation to this URL
 *   in an opaque origin, so even a type we got wrong could not reach the
 *   session.
 *
 * `Content-Disposition: inline` with a fixed name rather than the uploaded
 * filename: the filename is user text, and it is worth nothing in a header
 * that has historically been parsed by every client differently.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const asset = await assetByToken(token);
  if (!asset) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(asset.bytes), {
    headers: {
      "Content-Type": asset.contentType,
      "Content-Length": String(asset.size),
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      // Content-addressed in practice: an edit is a new upload with a new
      // token, so a URL's bytes never change and a year is honest. Mail
      // clients and their image proxies both cache aggressively, and being
      // explicit is what stops Gmail re-fetching a logo per recipient.
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: `"${asset.sha256}"`,
    },
  });
}
