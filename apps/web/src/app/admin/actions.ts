"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireInstanceAdmin } from "@/lib/session";
import { requestMeta } from "@/lib/audit";
import type { Result } from "@/lib/result";
import { updateInstanceSettings } from "@/services/instance-settings";

const SIGNUP_MODES = ["open", "invite", "closed"] as const;
const instanceForm = z.object({
  signupMode: z.enum([...SIGNUP_MODES, "auto"]),
  landingEnabled: z.enum(["on", "off"]),
  retentionDays: z.coerce
    .number({ error: "Maximum retention must be a number." })
    .int("Maximum retention must be a whole number.")
    .min(1, "Maximum retention must be at least 1.")
    .max(3650, "Maximum retention must be at most 3650."),
  // Blank is "no instance-wide cap", which is what it was before there was a
  // field for it — so an empty string has to survive the parse as null rather
  // than coerce to 0, which would be a cap of nothing.
  defaultDailyLimit: cap("daily"),
  defaultMonthlyLimit: cap("monthly"),
});

function cap(which: string) {
  return z
    .union([z.literal(""), z.coerce.number()])
    .transform((v) => (v === "" ? null : v))
    .refine((v) => v === null || (Number.isInteger(v) && v >= 1), {
      message: `The default ${which} limit must be a whole number of at least 1, or blank for none.`,
    });
}

/**
 * Instance admin only: signup mode (`auto` clears the DB override), landing
 * page, and the retention **ceiling** every team is clamped to.
 */
export async function updateInstanceAction(fd: FormData): Promise<Result> {
  const s = await requireInstanceAdmin();
  const actor = { userId: s.user.id, meta: requestMeta(await headers()) };
  const parsed = instanceForm.safeParse({
    signupMode: fd.get("signupMode"),
    landingEnabled: fd.get("landingEnabled") ?? "off",
    retentionDays: fd.get("retentionDays"),
    defaultDailyLimit: fd.get("defaultDailyLimit") ?? "",
    defaultMonthlyLimit: fd.get("defaultMonthlyLimit") ?? "",
  });
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  const {
    signupMode,
    landingEnabled,
    retentionDays,
    defaultDailyLimit,
    defaultMonthlyLimit,
  } = parsed.data;
  await updateInstanceSettings(
    {
      signupMode: signupMode === "auto" ? null : signupMode,
      landingEnabled: landingEnabled === "on",
      retentionDays,
      defaultDailyLimit,
      defaultMonthlyLimit,
    },
    actor,
  );
  revalidatePath("/admin");
  return { ok: true, data: undefined };
}
