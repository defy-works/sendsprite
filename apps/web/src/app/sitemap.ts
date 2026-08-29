import type { MetadataRoute } from "next";
import { COMPETITORS } from "@/components/alternatives/competitors";
import { DOCS_NAV } from "@/app/docs/nav";
import { isLandingEnabled, siteOrigin } from "@/services/landing";

// Metadata routes are prerendered at build unless told otherwise; this one
// reads the instance settings from the database, which only exists at runtime.
export const dynamic = "force-dynamic";

/** `/sitemap.xml`: the marketing pages, the docs and the legal pages. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!(await isLandingEnabled())) return [];
  const origin = siteOrigin();
  const at = (
    path: string,
    priority: number,
    changeFrequency: "weekly" | "monthly",
  ) => ({
    url: `${origin}${path}`,
    priority,
    changeFrequency,
  });
  return [
    at("/", 1, "weekly"),
    at("/alternatives", 0.9, "weekly"),
    ...COMPETITORS.map((c) => at(`/alternatives/${c.slug}`, 0.9, "weekly")),
    ...DOCS_NAV.filter((d) => !d.soon).map((d) =>
      at(d.href, d.href === "/docs" ? 0.7 : 0.6, "weekly"),
    ),
    at("/terms", 0.2, "monthly"),
    at("/privacy", 0.2, "monthly"),
    at("/license", 0.3, "monthly"),
  ];
}
