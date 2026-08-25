import { recordTrackingHit } from "@/services/tracking";

export const dynamic = "force-dynamic";

/** 1x1 transparent GIF. */
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

/**
 * Open pixel `/t/o/<emailId>.gif`. Always answers the gif, whatever the id
 * or the outcome of recording; `no-store` so every render hits us.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  // Only the `.gif` form is what `pixelTag` renders; anything else is a
  // curious browser, still answered with the gif but not counted.
  if (id.endsWith(".gif"))
    await recordTrackingHit(id.slice(0, -4), {
      type: "opened",
      headers: req.headers,
    });
  return new Response(PIXEL, {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL.length),
      "cache-control": "no-store, private",
    },
  });
}
