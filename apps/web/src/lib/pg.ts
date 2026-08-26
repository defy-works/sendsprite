/**
 * Postgres SQLSTATE, on the driver error or (drizzle) its `cause`.
 *
 * drizzle wraps the `postgres` driver's error, so the code is one level down
 * on anything that came through a query builder and at the top level on
 * anything that did not. Reading both is what makes a unique-violation check
 * work regardless of which layer threw.
 *
 * Lifted out of `services/templates.ts` when a second table needed it. The
 * codes worth naming: `23505` unique violation, `23503` foreign key,
 * `23514` check constraint.
 */
export const pgCode = (e: unknown): string | undefined => {
  const o = e as { code?: string; cause?: { code?: string } } | null;
  return o?.code ?? o?.cause?.code;
};
