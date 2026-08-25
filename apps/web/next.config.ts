import createMDX from "@next/mdx";
import type { NextConfig } from "next";

/**
 * True for `next dev`, and for the one other thing that builds in development
 * mode: the e2e server (scripts/e2e-server.ts), which compiles the app ahead
 * of the run so no route compiles during it. Every real build — `bun run
 * build`, the Docker image — runs with NODE_ENV=production and takes the
 * other branch of each option below.
 */
const developmentMode = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server for the Docker image (see Dockerfile). A
  // development build is never deployed, and `next start` warns when it finds
  // a standalone directory it is not going to serve from, so skip it there.
  output: developmentMode ? undefined : "standalone",
  // `/docs` is written in MDX; `page.mdx` must count as a route file.
  pageExtensions: ["ts", "tsx", "mdx"],
  // Migrations run at boot from instrumentation.ts, so the SQL files must
  // ship inside the standalone bundle.
  outputFileTracingIncludes: { "/**": ["./drizzle/**/*"] },
  experimental: {
    /**
     * What lets `next build` run at all in development mode. Its only effect
     * is the literal `next build` replaces `process.env.NODE_ENV` with in the
     * bundles, and the e2e needs `development` there: the fake SES/SNS/STS
     * client is armed by `process.env.NODE_ENV !== "production"` in
     * lib/aws/clients.ts, which a production build folds to `false` before the
     * server ever starts — on purpose, and that guard stands.
     *
     * Next refuses this option unless NODE_ENV is explicitly `development`, so
     * a production build cannot pick it up: it is `undefined` there, and would
     * throw if it were not.
     */
    allowDevelopmentBuild: developmentMode ? true : undefined,
  },
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
