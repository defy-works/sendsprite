export const Q = {
  heartbeat: "system.heartbeat",
  sesRefreshAccount: "ses.refresh-account",
  domainProvision: "domain.provision",
  domainVerify: "domain.verify",
  domainVerifySweep: "domain.verify-sweep",
  // Phase 3+: "email.send", "webhook.deliver", "retention.purge"
} as const;
export type QueueName = (typeof Q)[keyof typeof Q];
