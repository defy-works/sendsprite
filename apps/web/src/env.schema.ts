import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === "boolean"
      ? v
      : !["false", "0", "no", "off", ""].includes(v.toLowerCase()),
  );

export const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  APP_URL: z.url({ error: "APP_URL must be a full URL incl. protocol" }),
  APP_SECRET: z
    .string()
    .min(32, "APP_SECRET must be at least 32 characters")
    .refine(
      (s) => !/^change-me/i.test(s),
      "APP_SECRET is still the placeholder",
    ),
  DATABASE_URL: z.string().min(1),
  WORKER_MODE: z.enum(["inline", "separate", "none"]).default("inline"),
  SMTP_ENABLED: bool.default(true),
  LANDING_ENABLED: bool.default(true),
  SIGNUP_MODE: z.enum(["auto", "open", "invite", "closed"]).default("auto"),
  EMAIL_RETENTION_DAYS: z.coerce.number().int().min(1).default(90),
  EMAIL_PASSWORD_ENABLED: bool.default(false),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof schema> & {
  providers: {
    google: boolean;
    github: boolean;
    emailPassword: boolean;
    any: boolean;
  };
};

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const google = Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);
  const github = Boolean(e.GITHUB_CLIENT_ID && e.GITHUB_CLIENT_SECRET);
  const emailPassword = e.EMAIL_PASSWORD_ENABLED;
  return {
    ...e,
    providers: {
      google,
      github,
      emailPassword,
      any: google || github || emailPassword,
    },
  };
}
