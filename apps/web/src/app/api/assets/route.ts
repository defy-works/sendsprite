import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { env } from "@/env";
import { requestMeta } from "@/lib/audit";
import { requireApiSession } from "@/lib/session";
import {
  MAX_ASSET_BYTES,
  assetUrl,
  listAssets,
  uploadAsset,
} from "@/services/assets";

export const dynamic = "force-dynamic";

/**
 * Image upload, for the dashboard editor.
 *
 * A route handler rather than a server action because the payload is binary
 * and multi-megabyte: `serverActions.bodySizeLimit` would have to be raised
 * for every action in the app to accommodate one of them, and a server
 * action's encoding wraps the bytes rather than streaming them.
 *
 * Deliberately **not** under `/api/v1`. That prefix is the documented,
 * API-key-authenticated, OpenAPI-described product surface, and this is a
 * session-authenticated dashboard endpoint — putting it there would make it a
 * contract we have to keep.
 *
 * ## Why a session cookie is enough
 *
 * The auth cookie is `SameSite=Lax`, so a cross-site `POST` does not carry it
 * and cannot reach this at all. The `Origin` check below is the belt to that
 * brace: it costs one comparison and it fails closed if the cookie policy ever
 * loosens.
 */
function sameOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(env.APP_URL).origin;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const h = await headers();
  if (!sameOrigin(h.get("origin")))
    return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const ctx = await requireApiSession();
  if (!ctx.ok) return ctx.response;

  // Checked before the body is read, so an oversized upload is refused on the
  // header rather than after two megabytes have been buffered.
  const declared = Number(h.get("content-length") ?? "0");
  if (declared > MAX_ASSET_BYTES * 1.1)
    return NextResponse.json({ error: "too_large" }, { status: 413 });

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "no_file" }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const res = await uploadAsset(
    { userId: ctx.userId, teamId: ctx.teamId, meta: requestMeta(h) },
    { filename: file.name, bytes },
  );
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 400 });
  return NextResponse.json({
    ...res.data,
    url: assetUrl(env.APP_URL, res.data.token),
  });
}

/** The team's recent uploads, for the picker. */
export async function GET() {
  const ctx = await requireApiSession();
  if (!ctx.ok) return ctx.response;
  const assets = await listAssets(ctx.teamId);
  return NextResponse.json({
    assets: assets.map((a) => ({
      ...a,
      url: assetUrl(env.APP_URL, a.token),
    })),
  });
}
