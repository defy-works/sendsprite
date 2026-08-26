/**
 * Who may change instance-wide settings. Two independent sources:
 *
 *  - `INSTANCE_ADMIN_EMAILS` — an escape hatch that always works and cannot
 *    be revoked from the UI, so a self-hoster can never lock themselves out.
 *  - `user.instanceAdmin` — the flag the admin page toggles.
 *
 * Pure so it is unit-testable; `requireInstanceAdmin` in `lib/session.ts`
 * supplies the session and the env.
 */
export function parseAdminEmails(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
}

export function isInstanceAdmin(
  user: { email: string; flag: boolean },
  adminEmails: readonly string[],
): boolean {
  return user.flag || adminEmails.includes(user.email.trim().toLowerCase());
}
