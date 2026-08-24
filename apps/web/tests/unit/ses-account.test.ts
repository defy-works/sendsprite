import { describe, expect, it } from "vitest";
import { mapAccount } from "@/lib/aws/ses-account";

describe("mapAccount", () => {
  it("maps sandbox account", () => {
    expect(
      mapAccount({
        ProductionAccessEnabled: false,
        SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 0 },
      }),
    ).toEqual({
      status: "sandbox",
      reviewStatus: null,
      dailyQuota: 200,
      maxSendRate: 1,
    });
  });
  it("maps pending review", () => {
    expect(
      mapAccount({
        ProductionAccessEnabled: false,
        Details: { ReviewDetails: { Status: "PENDING" } },
        SendQuota: { Max24HourSend: 200, MaxSendRate: 1 },
      }),
    ).toMatchObject({ status: "requested", reviewStatus: "PENDING" });
  });
  it("maps a denied review back to sandbox", () => {
    expect(
      mapAccount({
        ProductionAccessEnabled: false,
        Details: { ReviewDetails: { Status: "DENIED" } },
      }),
    ).toMatchObject({ status: "sandbox", reviewStatus: "DENIED" });
  });
  it("maps production", () => {
    expect(
      mapAccount({
        ProductionAccessEnabled: true,
        SendQuota: { Max24HourSend: 50000, MaxSendRate: 14 },
      }),
    ).toMatchObject({
      status: "production",
      dailyQuota: 50000,
      maxSendRate: 14,
    });
  });
  it("tolerates missing quota", () => {
    expect(mapAccount({ ProductionAccessEnabled: false })).toMatchObject({
      dailyQuota: null,
      maxSendRate: null,
    });
  });
});
