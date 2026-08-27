export type SignupMode = "open" | "invite" | "closed";
export type EnvSignupMode = SignupMode | "auto";

/**
 * Env wins when explicit. `auto` defers to the DB override if present,
 * otherwise opens signup only until the first user exists.
 */
export function resolveSignupMode(
  envMode: EnvSignupMode,
  dbOverride: SignupMode | null,
  userCount: number,
): SignupMode {
  if (envMode !== "auto") return envMode;
  if (dbOverride) return dbOverride;
  return userCount === 0 ? "open" : "invite";
}

export function canSignUp(
  mode: SignupMode,
  hasPendingInvitation: boolean,
): boolean {
  if (mode === "open") return true;
  if (mode === "invite") return hasPendingInvitation;
  return false;
}
