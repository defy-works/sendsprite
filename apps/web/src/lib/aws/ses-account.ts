import type { GetAccountResponse } from "@aws-sdk/client-sesv2";

export type SesAccountStatus = "sandbox" | "requested" | "production";
export type SesReviewStatus = "PENDING" | "GRANTED" | "DENIED" | "FAILED";
export interface SesAccount {
  status: SesAccountStatus;
  reviewStatus: SesReviewStatus | null;
  dailyQuota: number | null;
  maxSendRate: number | null;
}

/** GetAccount → the instance-level SES fields (pure; see `instance_settings`). */
export function mapAccount(a: GetAccountResponse): SesAccount {
  const review =
    (a.Details?.ReviewDetails?.Status as SesReviewStatus | undefined) ?? null;
  const status: SesAccountStatus = a.ProductionAccessEnabled
    ? "production"
    : review === "PENDING"
      ? "requested"
      : "sandbox";
  return {
    status,
    reviewStatus: review,
    dailyQuota: a.SendQuota?.Max24HourSend ?? null,
    maxSendRate: a.SendQuota?.MaxSendRate ?? null,
  };
}
