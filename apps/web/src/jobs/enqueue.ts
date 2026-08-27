import { getBoss } from "./boss";
import type { Enqueue } from "@/services/domains";

/**
 * Service → pg-boss bridge, shared by job handlers and server actions.
 * `startAfter` stays a number of seconds: pg-boss 12 stringifies a number
 * and Postgres casts it to an interval. `singletonKey` passes through; it
 * only dedups on a queue whose policy enforces it (see `domain-verify.ts`).
 */
export const enqueue: Enqueue = async (queue, data, opts) =>
  (await getBoss()).send(queue, data, {
    ...(opts?.startAfter !== undefined && { startAfter: opts.startAfter }),
    ...(opts?.singletonKey !== undefined && {
      singletonKey: opts.singletonKey,
    }),
  });
