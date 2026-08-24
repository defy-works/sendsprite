/**
 * Tiny classname merger - drops falsy values and joins with a space.
 *
 * Intentionally dependency-free, matching site_v2. If we later need
 * twMerge-style conflict resolution, swap this out without touching
 * consumers.
 */
export function cn(
  ...classes: Array<string | undefined | null | false | 0>
): string {
  return classes.filter(Boolean).join(" ");
}
