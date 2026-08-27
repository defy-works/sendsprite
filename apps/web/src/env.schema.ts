import { z } from "zod";
import { GRANTABLE_PLANS } from "@sendsprite/shared";
import { SES_REGIONS } from "@/lib/aws/regions";
import { isS3TemplateUrl } from "@/lib/aws/quick-create";
import { CF_DEFAULT_SCOPES } from "@/lib/cloudflare/scopes";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === "boolean"
      ? v
      : !["false", "0", "no", "off", ""].includes(v.toLowerCase()),
  );

export const schema = z
  .object({
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
    // AUTH on a plain (pre-STARTTLS) connection. Dev only: the API key travels in clear.
    SMTP_ALLOW_INSECURE_AUTH: bool.default(false),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    // PEM file paths; both or neither (a self-signed cert is generated otherwise).
    SMTP_TLS_CERT: z.string().min(1).optional(),
    SMTP_TLS_KEY: z.string().min(1).optional(),
    SMTP_MAX_SIZE: z.coerce
      .number()
      .int()
      .min(1024)
      .default(10 * 1024 * 1024),
    LANDING_ENABLED: bool.default(true),
    /**
     * Hosted-service billing. Off by default: a self-hosted instance never
     * sees a Billing page, a checkout, or a provider webhook endpoint, and
     * `send-limits.ts` behaves exactly as it does without this phase.
     */
    BILLING_ENABLED: bool.default(false),
    /** `fake` is an in-memory provider for tests and e2e; never in production. */
    BILLING_PROVIDER: z.enum(["polar", "fake"]).default("polar"),
    /** Usage event name ingested to the provider; must match the meter's filter. */
    BILLING_EVENT_NAME: z.string().min(1).default("email.sent"),
    POLAR_ACCESS_TOKEN: z.string().min(1).optional(),
    POLAR_WEBHOOK_SECRET: z.string().min(1).optional(),
    POLAR_SERVER: z.enum(["sandbox", "production"]).default("production"),
    /**
     * Optional, display only: with it set the billing page can also show the
     * provider's own meter balance next to ours. Billing does not need it —
     * usage events are ingested by name, and the meter is configured by hand
     * in the Polar dashboard.
     */
    POLAR_METER_ID: z.string().min(1).optional(),
    /**
     * Plan a team with no subscription and no grant resolves to. Only with
     * billing on.
     *
     * "No subscription" includes a subscription that has *stopped* entitling —
     * canceled, unpaid, or past due beyond its grace window — not just a team
     * that never bought. So `DEFAULT_PLAN=scale` means cancelling costs a
     * customer nothing: they keep the Scale allowance for as long as they stay.
     * Leave it `free` on a hosted instance.
     */
    DEFAULT_PLAN: z.enum(GRANTABLE_PLANS).default("free"),
    SIGNUP_MODE: z.enum(["auto", "open", "invite", "closed"]).default("auto"),
    /**
     * Comma-separated emails that always pass `requireInstanceAdmin`,
     * whatever `user.instanceAdmin` says. The lockout escape hatch: a
     * self-hoster who removed their own flag fixes it here. Leave it unset
     * and the first user to sign up is flagged instead.
     */
    INSTANCE_ADMIN_EMAILS: z.string().optional(),
    EMAIL_PASSWORD_ENABLED: bool.default(false),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    /**
     * Cloudflare OAuth client (Manage Account → OAuth clients). With both
     * set, Sendsprite can write a domain's DNS records itself once the owner
     * authorises it; without them every domain falls back to the manual
     * records list plus a dashboard deep link, which needs no credentials.
     *
     * The redirect URI registered on the client must be exactly
     * `<APP_URL>/api/setup/cloudflare/callback`. Cloudflare matches redirect
     * URIs exactly, so a self-hosted instance cannot borrow someone else's
     * client — it registers its own (private visibility is enough for that).
     */
    CLOUDFLARE_OAUTH_CLIENT_ID: z.string().min(1).optional(),
    CLOUDFLARE_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
    /** Space-separated. See CF_DEFAULT_SCOPES in lib/cloudflare/scopes.ts. */
    CLOUDFLARE_OAUTH_SCOPES: z.string().min(1).default(CF_DEFAULT_SCOPES),
    // CloudFormation quick-create only accepts S3 template URLs.
    CFN_TEMPLATE_URL: z
      .url()
      .refine(
        isS3TemplateUrl,
        "CFN_TEMPLATE_URL must be an S3 URL (CloudFormation quick-create only accepts S3)",
      )
      .default(
        "https://sendsprite-cfn.s3.us-east-1.amazonaws.com/latest/sendsprite-connect.yaml",
      ),
    AWS_DEFAULT_REGION: z.enum(SES_REGIONS).default("us-east-1"),
  })
  .refine((e) => Boolean(e.SMTP_TLS_CERT) === Boolean(e.SMTP_TLS_KEY), {
    message: "SMTP_TLS_CERT and SMTP_TLS_KEY must be set together",
    path: ["SMTP_TLS_CERT"],
  })
  .refine(
    (e) =>
      !e.BILLING_ENABLED ||
      e.BILLING_PROVIDER === "fake" ||
      Boolean(e.POLAR_ACCESS_TOKEN),
    {
      message: "BILLING_ENABLED requires POLAR_ACCESS_TOKEN",
      path: ["POLAR_ACCESS_TOKEN"],
    },
  )
  .refine(
    (e) =>
      !e.BILLING_ENABLED ||
      e.BILLING_PROVIDER === "fake" ||
      Boolean(e.POLAR_WEBHOOK_SECRET),
    {
      message: "BILLING_ENABLED requires POLAR_WEBHOOK_SECRET",
      path: ["POLAR_WEBHOOK_SECRET"],
    },
  )
  .refine((e) => e.BILLING_ENABLED || e.DEFAULT_PLAN === "free", {
    message: "DEFAULT_PLAN requires BILLING_ENABLED",
    path: ["DEFAULT_PLAN"],
  })
  .refine((e) => e.NODE_ENV !== "production" || e.BILLING_PROVIDER !== "fake", {
    message: "BILLING_PROVIDER=fake is refused in production",
    path: ["BILLING_PROVIDER"],
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

let cached: Env | undefined;
/** Cached parse of process.env. Server/CLI/test use; pages should import `env` from "@/env". */
export function loadEnv(): Env {
  return (cached ??= parseEnv(process.env));
}
export function resetEnvCache() {
  cached = undefined;
}
