/**
 * Service return shape: callers branch on `ok` instead of catching. `code` is
 * the upstream error name (e.g. an AWS error name) when one is known.
 */
export type Result<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string; code?: string };
