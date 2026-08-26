/**
 * What this build is, and where its source can be had. The AGPL makes the
 * second one an operator's responsibility, so both are read from the same
 * place: `/api/health` and the dashboard footer can never disagree.
 */

/**
 * Upstream Sendsprite, and the default for `SOURCE_URL`. An unmodified
 * instance discharges AGPL section 13 by pointing at the code it was built
 * from; a modified one must point `SOURCE_URL` at its own source instead.
 */
export const UPSTREAM_SOURCE_URL = "https://github.com/defy-works/sendsprite";

/**
 * The running build. Baked in at image build time (`ARG APP_VERSION` in the
 * Dockerfile); "dev" for anything else.
 */
export function appVersion(): string {
  return process.env.APP_VERSION ?? "dev";
}

/**
 * Where this instance offers its Corresponding Source. Shape is validated at
 * boot by `env.schema.ts`; it is read straight from `process.env` here so the
 * health payload and the shell can use it without pulling in the whole env
 * parse (the same way `WORKER_MODE` is read in `lib/health.ts`).
 */
export function sourceUrl(): string {
  return process.env.SOURCE_URL || UPSTREAM_SOURCE_URL;
}
