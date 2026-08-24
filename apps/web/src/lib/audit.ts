import { newId } from "@sendsprite/shared";
import { db } from "@/db";
import { auditLog } from "@/db/schema";

export type Diff = Record<string, { from?: unknown; to?: unknown }>;
const REDACT = /(enc|secret|token|password)$/i;

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

export async function recordAudit(input: AuditInput) {
  await db()
    .insert(auditLog)
    .values({ id: newId("aud"), ...input });
}
