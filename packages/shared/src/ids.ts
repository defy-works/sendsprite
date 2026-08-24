import { ulid } from "ulid";

export const ID_PREFIXES = [
  "usr", "team", "inv", "em", "evt", "dom", "key", "wh", "whd",
  "tpl", "cb", "ct", "cmp", "sup", "aud",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/** Prefixed, sortable, URL-safe id: `em_01ARZ3NDEKTSV4RRFFQ69G5FAV`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function parseId(id: string): { prefix: IdPrefix; ulid: string } | null {
  const i = id.indexOf("_");
  if (i <= 0) return null;
  const prefix = id.slice(0, i) as IdPrefix;
  const rest = id.slice(i + 1);
  if (!ID_PREFIXES.includes(prefix) || !ULID_RE.test(rest)) return null;
  return { prefix, ulid: rest };
}
