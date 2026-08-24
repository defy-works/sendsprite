# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14 AS base
# /app must be the same absolute root in `build` and `runner`: the traced
# node_modules symlinks in the standalone output may be absolute.
WORKDIR /app

# Dependencies only: workspace manifests + lockfile so this layer is cached
# until a package.json changes. Bun's isolated linker puts the real packages
# in /app/node_modules/.bun and symlinks them per workspace.
FROM base AS deps
COPY package.json bun.lock bunfig.toml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile

# Build on top of deps so every workspace's node_modules (and their symlinks
# into .bun) come along. .dockerignore keeps host node_modules/.next out of
# the context, so COPY . . only adds sources. packages/shared is a source
# package consumed via workspace:*, so it must be present here.
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN --mount=type=cache,target=/app/apps/web/.next/cache \
    cd apps/web && bun run build

FROM base AS runner
ARG APP_VERSION=dev
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
# APP_VERSION is reported by /api/health. NEXT_MANUAL_SIG_HANDLE hands
# SIGTERM to instrumentation.ts, which stops pg-boss before exiting.
ENV APP_VERSION=$APP_VERSION NEXT_MANUAL_SIG_HANDLE=true
# `output: "standalone"` in a monorepo emits:
#   .next/standalone/apps/web/server.js       entry (reads PORT/HOSTNAME)
#   .next/standalone/apps/web/.next/          server chunks
#   .next/standalone/apps/web/drizzle/        via outputFileTracingIncludes
#   .next/standalone/node_modules/.bun/       traced runtime packages
# It deliberately omits .next/static and public/, so those are copied
# alongside; leaving either out serves pages without CSS or fonts.
COPY --from=build --chown=bun:bun /app/apps/web/.next/standalone ./
COPY --from=build --chown=bun:bun /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=bun:bun /app/apps/web/public ./apps/web/public
USER bun
WORKDIR /app/apps/web
# SMTP relay (587) arrives in Phase 3.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "server.js"]
