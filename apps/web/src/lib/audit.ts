import { newId } from "@sendsprite/shared";
import { db } from "@/db";
import { auditLog } from "@/db/schema";

export type Diff = Record<string, { from?: unknown; to?: unknown }>;
// Substring match, fail-closed: "tokenCount" is redacted too.
const REDACT = /(enc|secret|token|password|hash|key)/i;

export function computeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Diff | null {
  const diff: Diff = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (Object.is(before[key], after[key])) continue;
    diff[key] = REDACT.test(key)
      ? { from: "[redacted]", to: "[redacted]" }
      : { from: before[key], to: after[key] };
  }
  return Object.keys(diff).length ? diff : null;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/** Pull client ip / UA from request headers (proxy-aware). No `next/*` import. */
export function requestMeta(h: Headers): RequestMeta {
  const fwd = h.get("x-forwarded-for");
  const ip = (fwd ? fwd.split(",")[0]?.trim() : h.get("x-real-ip")) || null;
  return { ip, userAgent: h.get("user-agent") };
}

export interface AuditInput {
  teamId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType: string;
  targetId: string;
  diff?: Diff | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Best-effort audit write. Never throws: mutations happen via better-auth
 * outside our transaction, so an audit failure must not break (or half-apply)
 * the mutation it describes. Failures are logged instead.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await db()
      .insert(auditLog)
      .values({ id: newId("aud"), ...input });
  } catch (err) {
    // Message + code only: the failing row may carry user data.
    console.error(
      "[audit] failed",
      (err as { code?: string }).code,
      (err as Error).message,
    );
  }
}
