/** Service return shape: callers branch on `ok` instead of catching. */
export type Result<T = undefined> =
  { ok: true; data: T } | { ok: false; error: string };
