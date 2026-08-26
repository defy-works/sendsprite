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
});

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
  });
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the form.",
    };
  const { signupMode, landingEnabled, retentionDays } = parsed.data;
  await updateInstanceSettings(
    {
      signupMode: signupMode === "auto" ? null : signupMode,
      landingEnabled: landingEnabled === "on",
      retentionDays,
    },
    actor,
  );
  revalidatePath("/app/admin");
  return { ok: true, data: undefined };
}
