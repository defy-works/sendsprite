import { ApiReference } from "@scalar/nextjs-api-reference";

// The document itself is built per request from the shared contracts.
export const dynamic = "force-dynamic";

/**
 * Scalar API reference over `/api/v1/openapi.json`. The route returns a
 * standalone HTML document (the reference bundle is loaded from Scalar's
 * CDN), so it sits outside the MDX docs shell — hence the forced dark state,
 * which is the only way to keep it visually next to the rest of the app.
 */
export const GET = ApiReference({
  url: "/api/v1/openapi.json",
  theme: "kepler",
  darkMode: true,
  forceDarkModeState: "dark",
  hideDarkModeToggle: true,
  title: "Sendsprite API",
  pageTitle: "Sendsprite API reference",
});
