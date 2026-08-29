import type { MetadataRoute } from "next";
import { isLandingEnabled, siteOrigin } from "@/services/landing";

/**
 * `/robots.txt`. A self-hosted instance with the landing off has nothing a
 * search engine should index — every remaining route is an account's own
 * dashboard — so it disallows everything. With the landing on, the public
 * pages are open and the app, admin, API and tracking routes stay out.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = siteOrigin();
  if (!(await isLandingEnabled())) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/app",
        "/admin",
        "/api/",
        "/setup",
        "/invite/",
        "/a/",
        "/t/",
        "/unsubscribe/",
        "/login",
        "/signup",
      ],
    },
    sitemap: `${origin}/sitemap.xml`,
  };
}
