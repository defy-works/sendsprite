export const Q = {
  heartbeat: "system.heartbeat",
  // Phase 2+: "domain.provision", "domain.verify", "email.send", "webhook.deliver", "retention.purge"
} as const;
export type QueueName = (typeof Q)[keyof typeof Q];
