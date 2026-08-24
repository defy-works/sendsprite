/**
 * The zone that should hold `domain`'s records: the zone whose name equals
 * the domain or is its longest label-aligned suffix. `null` when none match.
 */
export function matchZone<Z extends { name: string }>(
  domain: string,
  zones: Z[],
): Z | null {
  const d = domain.toLowerCase();
  let best: Z | null = null;
  for (const z of zones) {
    const n = z.name.toLowerCase();
    if (
      (d === n || d.endsWith(`.${n}`)) &&
      (!best || n.length > best.name.length)
    )
      best = z;
  }
  return best;
}
