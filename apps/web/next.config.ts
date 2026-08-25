import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server for the Docker image (see Dockerfile).
  output: "standalone",
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

export default nextConfig;
