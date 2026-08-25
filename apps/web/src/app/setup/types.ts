export const STEPS = ["aws", "production", "cloudflare", "done"] as const;
export type Step = (typeof STEPS)[number];

/** The non-secret slice of instance settings the wizard renders. */
export interface WizardSettings {
  awsMode: "none" | "instance_role" | "keys";
  awsRegion: string | null;
  awsAccountId: string | null;
  sesAccountStatus: "sandbox" | "requested" | "production" | null;
  sesReviewStatus: "PENDING" | "GRANTED" | "DENIED" | "FAILED" | null;
  sesDailyQuota: number | null;
  sesMaxSendRate: number | null;
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
}
