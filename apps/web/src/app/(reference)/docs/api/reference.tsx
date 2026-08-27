"use client";

import { ApiReferenceReact } from "@scalar/api-reference-react";
// Imported here rather than pulled from a CDN: a Sendsprite instance may run
// on a private network or in an offline CI runner, so every byte the
// reference needs has to come out of this app's own bundle.
import "@scalar/api-reference-react/style.css";

/**
 * Scalar API reference over the instance's own `/api/v1/openapi.json`.
 *
 * The reference paints itself over the whole viewport and ships its own
 * (Tailwind-based) reset, which is why this route sits outside the `/docs`
 * shell — see the sibling `page.tsx`.
 */
export function ApiReference() {
  return (
    <ApiReferenceReact
      configuration={{
        url: "/api/v1/openapi.json",
        title: "Sendsprite API",
        theme: "kepler",
        // The app has no light mode, so neither does the reference.
        darkMode: true,
        forceDarkModeState: "dark",
        hideDarkModeToggle: true,
        // Scalar's default @font-face rules point at fonts.scalar.com; the
        // reference inherits the app's font stack instead.
        withDefaultFonts: false,
        // "Agent Scalar" turns itself on for any localhost URL and then talks
        // to api.scalar.com — which is most self-hosted instances, and not a
        // service this app may send anyone's API surface to.
        agent: { disabled: true },
        // Same story, one click further away: the developer toolbar also
        // defaults to showing on localhost, and its Share/Register buttons
        // POST the whole document to api.scalar.com / registry.scalar.com.
        showDeveloperTools: "never",
      }}
    />
  );
}
