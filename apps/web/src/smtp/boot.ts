import { startSmtp } from "./server";
import { loadOrGenerateCert } from "./tls";
import { setSmtpState } from "./state";

export interface RelayConfig {
  port: number;
  maxSize?: number;
  allowInsecureAuth?: boolean;
  /** PEM paths; a self-signed pair is generated when either is unset. */
  tlsCert?: string;
  tlsKey?: string;
}

const errno = (e: unknown) => {
  const code = (e as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
};

/** The most likely cause, in the terms the operator can act on. */
function hint(code: string | undefined, port: number): string {
  if (code === "EACCES" && port < 1024)
    return `port ${port} is privileged: only root, or a process holding CAP_NET_BIND_SERVICE, may bind below 1024 on Linux. Set SMTP_PORT above 1023 (the container image defaults to 2587) and publish ${port} on the host instead — Coolify and Kubernetes commonly drop that capability.`;
  if (code === "EACCES")
    return `the process is not allowed to bind port ${port}.`;
  if (code === "EADDRINUSE")
    return `port ${port} is already in use — another process, or a second copy of this app, holds it.`;
  if (code === "EADDRNOTAVAIL" || code === "ENOTFOUND")
    return `the bind address is not available on this host.`;
  if (code === "ENOENT")
    return `a file it needs is missing — check SMTP_TLS_CERT and SMTP_TLS_KEY.`;
  return `see the error above.`;
}

/**
 * Start the relay, turning any startup failure into a logged, non-fatal one.
 *
 * The relay is one optional feature of the web tier; a port conflict or a
 * privileged port is ordinary on a self-hosted box, and it must not take the
 * dashboard, the REST API and the worker down with it. The failure stays
 * discoverable: it is logged at error level with the port and the likely
 * cause, and /api/health reports `smtp: { status: "failed" }` (degraded)
 * for as long as the process runs.
 *
 * Returns whether the relay is listening.
 */
export async function startRelay(cfg: RelayConfig): Promise<boolean> {
  try {
    const tls = await loadOrGenerateCert({
      cert: cfg.tlsCert,
      key: cfg.tlsKey,
    });
    await startSmtp({
      port: cfg.port,
      maxSize: cfg.maxSize,
      allowInsecureAuth: cfg.allowInsecureAuth,
      tls,
    });
    return true;
  } catch (e) {
    const code = errno(e);
    setSmtpState({ status: "failed", port: cfg.port, code: code ?? "ERROR" });
    console.error(`[smtp] relay failed to start on port ${cfg.port}`, e);
    console.error(`[smtp] ${hint(code, cfg.port)}`);
    console.error(
      "[smtp] continuing without the relay: the dashboard, REST API and worker are unaffected, but this instance accepts no SMTP submission. Fix SMTP_PORT or set SMTP_ENABLED=false.",
    );
    return false;
  }
}
