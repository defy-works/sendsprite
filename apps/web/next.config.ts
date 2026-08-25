import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server for the Docker image (see Dockerfile).
  output: "standalone",
  // `/docs` is written in MDX; `page.mdx` must count as a route file.
  pageExtensions: ["ts", "tsx", "mdx"],
  // Migrations run at boot from instrumentation.ts, so the SQL files must
  // ship inside the standalone bundle.
  outputFileTracingIncludes: { "/**": ["./drizzle/**/*"] },
  // Node-only packages: keep out of the client bundle and Turbopack graph.
  serverExternalPackages: [
    "pg-boss",
    "postgres",
    "@aws-sdk/client-sesv2",
    "@aws-sdk/client-sns",
    "@aws-sdk/client-sts",
    "smtp-server",
    "mailparser",
    "selfsigned",
  ],
};

// `src/mdx-components.tsx` is picked up automatically as the component map.
// GFM adds the tables the docs pages use. The plugin is named as a string
// because Turbopack cannot receive a JavaScript function across the loader
// boundary (see next/dist/docs/01-app/02-guides/mdx.md).
const withMDX = createMDX({ options: { remarkPlugins: ["remark-gfm"] } });

export default withMDX(nextConfig);
