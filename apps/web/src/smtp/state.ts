/**
 * Where the SMTP relay got to, so an operator can see a relay that never
 * came up (/api/health reports it) rather than only finding it in the logs.
 *
 * Shared through globalThis for the same reason as `jobs/boss`: Next
 * evaluates this module once for the instrumentation hook and again for the
 * route handlers, so a plain module variable would report "disabled" from
 * /api/health while the relay is listening.
 */
export type SmtpStatus = "disabled" | "listening" | "failed";

export interface SmtpState {
  status: SmtpStatus;
  /** The port that was tried; absent while the relay is off. */
  port?: number;
  /**
   * Why it failed, as a short code (`EACCES`, `EADDRINUSE`, `ERROR`).
   * /api/health is unauthenticated, so the detail stays in the log.
   */
  code?: string;
}

const g = globalThis as { __sendspriteSmtp?: { state: SmtpState } };
const shared = (g.__sendspriteSmtp ??= { state: { status: "disabled" } });

export function getSmtpState(): SmtpState {
  return shared.state;
}

export function setSmtpState(state: SmtpState): void {
  shared.state = state;
}
