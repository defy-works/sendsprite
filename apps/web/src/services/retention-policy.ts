/**
 * How long one team's email bodies are kept.
 *
 * `instance_settings.retention_days` is a **ceiling**, not a default: a team
 * may shorten its window but never extend past what the operator allows, and
 * a team that has chosen nothing inherits the ceiling. Lowering the ceiling
 * therefore shortens every team that had asked for more, which is the point
 * — an operator must be able to bound their own disk.
 *
 * Pure, so the clamp is testable without a database.
 */
export function effectiveRetentionDays(
  teamDays: number | null,
  instanceMax: number,
): number {
  const wanted = teamDays ?? instanceMax;
  return Math.max(1, Math.min(wanted, instanceMax));
}
