import { buildOpenApiDocument } from "@sendsprite/shared/openapi";
import { env } from "@/env";

export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated: the document is derived from the shared
 * contracts and contains no instance data beyond the base URL.
 */
export async function GET() {
  return Response.json(
    buildOpenApiDocument({
      serverUrl: env.APP_URL,
      version: process.env.APP_VERSION ?? "dev",
    }),
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
