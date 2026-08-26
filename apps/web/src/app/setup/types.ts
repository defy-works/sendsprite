export const STEPS = ["aws", "production", "cloudflare", "done"] as const;
export type Step = (typeof STEPS)[number];

/**
 * The steps this instance actually has.
 *
 * A step nobody here can complete is not a step. Without a Cloudflare OAuth
 * client `CloudflareStep` renders nothing, so leaving it in the sequence gave
 * a fresh instance a dead stop: an empty panel with no Continue and no Skip,
 * reachable both from the rail and from the production step's own button. The
 * rail already hid it; the navigation did not, which is the half that stranded
 * people.
 */
export const stepsFor = (oauthAvailable: boolean): readonly Step[] =>
  oauthAvailable ? STEPS : STEPS.filter((s) => s !== "cloudflare");

/** The step after `from`, skipping any this instance does not have. */
export function nextStep(from: Step, oauthAvailable: boolean): Step {
  const steps = stepsFor(oauthAvailable);
  const i = steps.indexOf(from);
  return steps[Math.min(i + 1, steps.length - 1)] ?? "done";
}

/** The non-secret slice of a team's connection the wizard renders. */
export interface WizardSettings {
  /** The `team_aws` row exists; there is no separate "mode". */
  awsConnected: boolean;
  awsRegion: string | null;
  awsAccountId: string | null;
  sesAccountStatus: "sandbox" | "requested" | "production" | null;
  sesReviewStatus: "PENDING" | "GRANTED" | "DENIED" | "FAILED" | null;
  sesDailyQuota: number | null;
  sesMaxSendRate: number | null;
  /**
   * A topic exists but no confirmed subscription, so SES events are not being
   * delivered. Set on an instance migrated from the pre-team layout, whose
   * subscription still points at the old instance-wide webhook path.
   */
  snsSubscriptionMissing: boolean;
  cloudflareConnectedAt: string | null;
  cloudflareAccountName: string | null;
  setupCompleted: boolean;
}

export interface WizardProps {
  settings: WizardSettings;
  step: Step;
  regions: readonly string[];
  defaultRegion: string;
  /** False when APP_URL is not https (the CFN template refuses http callbacks). */
  oneClickAvailable: boolean;
  /**
   * Whether this instance has a Cloudflare OAuth client configured. False is
   * the self-hosted default: domains then fall back to manual records plus a
   * dashboard deep link.
   */
  oauthAvailable: boolean;
  /** `settings` hides the wizard's Continue/Skip navigation. Default `wizard`. */
  mode?: "wizard" | "settings";
}
