import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { requestMeta } from "@/lib/audit";
import { requireApiSession } from "@/lib/session";
import { deleteAsset } from "@/services/assets";

export const dynamic = "force-dynamic";

/**
 * Deletes an uploaded image.
 *
 * Team-scoped in the service, so an id from another tenant reports "already
 * gone" rather than deleting anything or confirming the id exists.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await requireApiSession();
  if (!ctx.ok) return ctx.response;
  const { id } = await params;
  const res = await deleteAsset(
    {
      userId: ctx.userId,
      teamId: ctx.teamId,
      meta: requestMeta(await headers()),
    },
    id,
  );
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 404 });
  return NextResponse.json({ ok: true });
}
