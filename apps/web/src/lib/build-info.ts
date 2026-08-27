/**
 * What this build is. Read from the same place by `/api/health` and the
 * dashboard footer, so the two can never disagree.
 */

/**
 * The running build. Baked in at image build time (`ARG APP_VERSION` in the
 * Dockerfile); "dev" for anything else.
 */
export function appVersion(): string {
  return process.env.APP_VERSION ?? "dev";
}
