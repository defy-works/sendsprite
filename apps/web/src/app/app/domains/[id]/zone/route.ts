import { requireTeam } from "@/lib/session";
import { bindZoneFilename, toBindZone } from "@/lib/dns/bind";
import { getDomain } from "@/services/domains";

export const dynamic = "force-dynamic";

/**
 * The domain's SES DNS as a BIND zone file. Session-authenticated (under
 * `/app`, not `/api/v1`), so not part of the OpenAPI surface, and no `can()`
 * on top: the same records already render on the page for any member, so
 * gating the file would only stop a member saving what they can read — the
 * same reasoning the contacts export route carries.
 *
 * 404 until provisioning has issued the records, which is exactly when the
 * download button appears on the page, so this is only reachable early by a
 * hand-typed URL.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const team = await requireTeam();
  const d = await getDomain(team.team.id, id);
  if (!d || d.expectedRecords.length === 0)
    return new Response("Not found", { status: 404 });

  return new Response(toBindZone(d.name, d.expectedRecords), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${bindZoneFilename(d.name)}"`,
      "cache-control": "no-store, private",
    },
  });
}
