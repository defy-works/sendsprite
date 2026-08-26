/**
 * `JSON.stringify` with object keys sorted at every depth, for comparing two
 * values that may have travelled through different paths.
 *
 * The reason this exists is Postgres `jsonb`, which does **not** preserve key
 * order: it stores keys sorted by length and then bytewise. So a value written
 * as `{"kind":"text","html":"x"}` reads back as `{"html":"x","kind":"text"}`,
 * and a plain `JSON.stringify` comparison of a freshly parsed input against
 * the stored row reports a difference that is not there.
 *
 * That is not cosmetic where a false "changed" has a side effect — cutting a
 * version row, reverting a scheduled campaign to a draft, or writing an audit
 * entry for an edit nobody made.
 *
 * Arrays keep their order, because in a `jsonb` array the order *is* the
 * value.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, val: unknown) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : val,
  );
}
