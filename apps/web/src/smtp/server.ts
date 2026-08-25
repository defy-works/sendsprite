import { SMTPServer } from "smtp-server";
import { authenticateSecret } from "@/lib/api-auth";
import { handleInbound, SmtpError, type SmtpUser } from "./inbound";
import { loadOrGenerateCert, type TlsPem } from "./tls";

let server: SMTPServer | undefined;

/**
 * Login throttle: after MAX_FAILURES bad passwords from one address within
 * WINDOW_MS, AUTH from that address is refused for LOCK_MS. The map is per
 * process (not shared across replicas) and entries are pruned on lookup.
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60_000;
const LOCK_MS = 10 * 60_000;
const failures = new Map<string, { count: number; until: number }>();

function lockedOut(ip: string, now = Date.now()) {
  const f = failures.get(ip);
  if (f && f.until <= now) failures.delete(ip);
  return Boolean(f && f.until > now && f.count >= MAX_FAILURES);
}
function recordFailure(ip: string, now = Date.now()) {
  const f = failures.get(ip);
  const count = f && f.until > now ? f.count + 1 : 1;
  failures.set(ip, {
    count,
    until: now + (count >= MAX_FAILURES ? LOCK_MS : WINDOW_MS),
  });
}
/** Tests only. */
export function resetLoginThrottle() {
  failures.clear();
}

const reply = (message: string, responseCode: number) =>
  Object.assign(new Error(message), { responseCode });
const toReply = (e: unknown) =>
  e instanceof SmtpError
    ? reply(e.message, e.responseCode)
    : reply("Temporary failure, try again later", 451);

export interface SmtpOptions {
  port: number;
  host?: string;
  /** PEM material, or generate a self-signed pair (default). */
  tls?: "selfsigned" | TlsPem;
  maxSize?: number;
}

/**
 * Submission relay: plain on `port` with STARTTLS offered; AUTH PLAIN/LOGIN
 * where the password is an API key (username ignored). Accepted messages go
 * through `createEmail` like a REST send. Rejects on the listen error (e.g.
 * EADDRINUSE); the caller decides whether that is fatal.
 */
export async function startSmtp(opts: SmtpOptions): Promise<void> {
  if (server) throw new Error("SMTP relay already started");
  const tls =
    !opts.tls || opts.tls === "selfsigned"
      ? await loadOrGenerateCert()
      : opts.tls;
  const s = new SMTPServer({
    banner: "Sendsprite SMTP relay",
    size: opts.maxSize ?? 10 * 1024 * 1024,
    secure: false,
    key: tls.key,
    cert: tls.cert,
    // AUTH before STARTTLS stays allowed: local/dev clients often skip TLS.
    allowInsecureAuth: true,
    authMethods: ["PLAIN", "LOGIN"],
    disableReverseLookup: true,
    onAuth(auth, session, cb) {
      const ip = session.remoteAddress;
      if (lockedOut(ip)) return cb(reply("Too many failed logins", 535));
      void authenticateSecret(auth.password ?? "").then(
        (a) => {
          if (!a.ok) {
            recordFailure(ip);
            return cb(reply("Invalid API key", 535));
          }
          const user: SmtpUser = {
            teamId: a.team.id,
            apiKeyId: a.key.id,
            keyDomainId: a.key.domainId,
          };
          cb(null, { user: user as unknown as string });
        },
        (e: unknown) => {
          console.error("[smtp] auth", e);
          cb(toReply(e));
        },
      );
    },
    onData(stream, session, cb) {
      void handleInbound(stream, session).then(
        () => cb(),
        (e: unknown) => {
          if (!(e instanceof SmtpError)) console.error("[smtp] inbound", e);
          cb(toReply(e));
        },
      );
    },
  });
  await new Promise<void>((resolve, rejectListen) => {
    s.once("error", rejectListen);
    s.listen(opts.port, opts.host ?? "0.0.0.0", () => {
      s.off("error", rejectListen);
      resolve();
    });
  });
  // Post-listen socket errors are logged rather than crashing the web tier.
  s.on("error", (e) => console.error("[smtp] server error", e));
  server = s;
  console.info(`[smtp] listening on ${opts.host ?? "0.0.0.0"}:${opts.port}`);
}

export async function stopSmtp(): Promise<void> {
  const s = server;
  server = undefined;
  if (!s) return;
  await new Promise<void>((r) => s.close(() => r()));
}
