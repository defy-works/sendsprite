export const Q = {
  heartbeat: "system.heartbeat",
  sesRefreshAccount: "ses.refresh-account",
  domainProvision: "domain.provision",
  domainVerify: "domain.verify",
  domainVerifySweep: "domain.verify-sweep",
  emailSend: "email.send",
  emailReconcile: "email.reconcile-sending",
  emailQueuedSweep: "email.queued-sweep",
  webhookDeliver: "webhook.deliver",
  webhookRetrySweep: "webhook.retry-sweep",
  retentionPurge: "retention.purge",
} as const;
export type QueueName = (typeof Q)[keyof typeof Q];
