"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requestMeta } from "@/lib/audit";
import { requireInstanceAdmin } from "@/lib/session";
import type { Result } from "@/lib/result";
import {
  renameOrganization,
  setInstanceAdmin,
  setUserBanned,
  setOrgOverrides,
  setOrgSuspended,
} from "@/services/admin";
import { getInstanceSettings } from "@/services/instance-settings";

/**
 * Instance-admin writes that reach into a single team.
 *
 * Every one of them re-runs `requireInstanceAdmin`. A server action is a POST
 * endpoint with a guessable id — the layout guarding `/admin` guards the
 * *rendering* of these pages and nothing about who may call the action.
 */
async function admin() {
  const s = await requireInstanceAdmin();
  return { userId: s.user.id, meta: requestMeta(await headers()) };
}

/** `""` means "no override", which is not the same as 0 (a cap of zero). */
const optionalCount = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : Number(v)))
  .refine(
    (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 100_000_000),
    "Limits must be whole numbers between 0 and 100,000,000.",
  );

const overridesForm = z.object({
  dailyLimit: optionalCount,
  monthlyLimit: optionalCount,
  retentionDays: z
    .string()
    .trim()
    .transform((v) => (v === "" ? null : Number(v)))
    .refine(
      (v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 3650),
      "Retention must be a whole number of days between 1 and 3650.",
    ),
});

export async function updateOrgOverrides(
  teamId: string,
  fd: FormData,
): Promise<Result> {
  const a = await admin();
  const parsed = overridesForm.safeParse({
    dailyLimit: String(fd.get("dailyLimit") ?? ""),
    monthlyLimit: String(fd.get("monthlyLimit") ?? ""),
    retentionDays: String(fd.get("retentionDays") ?? ""),
  });
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };

  // The ceiling is the instance's, and this form is no exception to it: an
  // operator raising one team above the deployment-wide maximum would leave
  // the nightly purge and the retention copy disagreeing about that team.
  const ceiling = (await getInstanceSettings()).retentionDays;
  if (parsed.data.retentionDays !== null && parsed.data.retentionDays > ceiling)
    return {
      ok: false,
      error: `The instance maximum is ${ceiling} days. Raise that first if this team needs longer.`,
    };

  const res = await setOrgOverrides(a, teamId, parsed.data);
  revalidatePath(`/admin/organizations/${teamId}`);
  revalidatePath("/admin/organizations");
  return res;
}

export async function suspendOrg(
  teamId: string,
  suspended: boolean,
  reason: string,
): Promise<Result> {
  const a = await admin();
  const trimmed = reason.trim().slice(0, 500);
  const res = await setOrgSuspended(
    a,
    teamId,
    suspended,
    trimmed === "" ? null : trimmed,
  );
  revalidatePath(`/admin/organizations/${teamId}`);
  revalidatePath("/admin/organizations");
  revalidatePath("/admin");
  return res;
}

/**
 * Locks an account out of the dashboard, or lets it back in.
 *
 * Separate from suspending a team, deliberately: this stops a person signing
 * in and leaves their teams' API keys sending. See `setUserBanned`.
 */
export async function banUser(
  userId: string,
  banned: boolean,
  reason: string | null,
): Promise<Result> {
  const a = await admin();
  const res = await setUserBanned(a, userId, banned, reason);
  revalidatePath("/admin/users");
  return res;
}

/** Renames a team and its slug, as the instance operator. */
export async function renameOrg(
  teamId: string,
  name: string,
  slug: string,
): Promise<Result> {
  const a = await admin();
  const res = await renameOrganization(a, teamId, { name, slug });
  revalidatePath(`/admin/organizations/${teamId}`);
  revalidatePath("/admin/organizations");
  return res;
}

export async function promoteUser(
  userId: string,
  value: boolean,
): Promise<Result> {
  const a = await admin();
  const res = await setInstanceAdmin(a, userId, value);
  revalidatePath("/admin/users");
  return res;
}
